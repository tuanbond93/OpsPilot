import type { SupabaseClient } from "@supabase/supabase-js";
import { generate } from "@/ai/provider";
import { logger } from "@/observability/logger";
import { buildContext, critique, detectCandidate, formatOperationalRiskPromptSummary, type AiRecommendation, type CurrentRisk, type DecisionContext, type IncomingAnswer, type LeadFact } from "@/domain/near-term-capacity";
import { TelegramClient } from "@/integrations/telegram/telegram-client";
import { buildNearTermFactCallbackData, formatNearTermDetailRequest, formatNearTermFactConfirmation, formatNearTermFactRequest, nearTermFactButtons, type NearTermFactAnswer } from "@/integrations/telegram/near-term-capacity-message";
import { NearTermCapacityDecisionBridge } from "@/services/near-term-capacity-decision-bridge";
import { NearTermCapacityShadowService } from "@/services/near-term-capacity-shadow";
import { NearTermCapacityMultiOptionShadowService, isMultiOptionShadowEnabled } from "@/services/near-term-capacity-multi-option-shadow";
import { resolveAuthorizedRecipients, resolveProvince, type ResolvedRecipient, type ScopeResolutionResult } from "@/notifications/gateway/scope-resolver";

export const NEAR_TERM_SHADOW_MODE = "SHADOW_DECISION_WITH_LIVE_FACT_COLLECTION" as const;

/** Stage 1 Governed Multi-Warehouse Rollout: strictly bounded to 3 verified pilot hubs */
export const STAGE_1_PILOT_WAREHOUSES = [
  "21161000", // Kho Giao Hàng Nặng - TP Yên Bái - Yên Bái (Baseline Golden Case)
  "21158000", // Kho Giao Hàng Nặng - TP Lào Cai - Lào Cai (MB03 heavy delivery hub)
  "21160000", // Kho Giao Hàng Nặng - Việt Trì - Phú Thọ (MB03 linehaul hub)
] as const;

export function isStage1PilotWarehouse(warehouseId: string): boolean {
  return (STAGE_1_PILOT_WAREHOUSES as readonly string[]).includes(String(warehouseId || ""));
}

export function isMultiWarehouseEnabled(): boolean {
  return process.env.NEAR_TERM_CAPACITY_MULTI_WAREHOUSE_ENABLED === "true";
}
const policy = { nearTermWindowMinutes: 240, leadFactMaxAgeMinutes: 60, allowedActions: ["NO_ACTION_MONITOR", "ADD_VEHICLE", "HOLD_LOW_PRIORITY_ECOM", "ADD_MANPOWER", "REALLOCATE_AVAILABLE_CAPACITY", "HUMAN_INVESTIGATION_REQUIRED"] as const };
type CaseRow = { id: string; warehouse_id: string; warehouse_name: string; current_risk_snapshot: CurrentRisk; lead_fact_snapshot: LeadFact | null; status: string; active: boolean };
type PilotGroup = { id: string; telegram_chat_id: string | number; status: string };
type PilotTopic = { group_id: string; message_thread_id: number; province_name: string | null; is_manager_decision: boolean; status: string };
type ScopedLeadRecipient = { member: ResolvedRecipient; chatId: string; messageThreadId: number; province: string };
type DetectorTelemetryContext = { checkpointAt: string; syncRunId: string };
type DetectorTelemetrySummary = {
  incidentsAvailable: number; incidentsScanned: number; candidatesDetected: number; candidatesPersisted: number;
  rejectedCount: number; missingSignalCount: number; noRiskCount: number; belowThresholdCount: number;
  outsideScopeCount: number; duplicateCount: number; activeCaseBlockCount: number; otherRejectionCount: number;
  startedAt: string; completedAt: string;
};

export function isRecoverableUnsentFactRequest(caseRow: Pick<CaseRow, "status" | "active">, sentEvent: unknown, factResponse: unknown) {
  return caseRow.active && caseRow.status === "FACT_REQUESTED" && !sentEvent && !factResponse;
}

async function callAiRecommendation(context: DecisionContext): Promise<AiRecommendation> {
  const allowed = context.allowedActions;
  const primaryAction = allowed[0] || "NO_ACTION_MONITOR";
  const evidenceRefs = context.facts.evidenceRefs;
  const now = Date.now();
  const requiredBy = new Date(now + 2 * 3600 * 1000).toISOString();
  const requiredFollowupAt = new Date(now + 4 * 3600 * 1000).toISOString();

  const prompt = `Return ONLY a valid JSON object (no markdown code fence, no text before or after) representing Phase 2 AiRecommendation matching this exact schema:
{
  "decision_case_id": "${context.decisionCaseId}",
  "recommended_action": "${primaryAction}",
  "confidence": 0.85,
  "reason_summary": "Tồn kho trong giới hạn kiểm soát và không có hàng lớn phát sinh trong 4h tới theo xác nhận từ Lead; duy trì theo dõi và xử lý theo quy trình hiện tại.",
  "current_risk": "${formatOperationalRiskPromptSummary(context.facts)}",
  "expected_state_if_no_action": "Tồn kho được giải tỏa dần theo ca làm việc tiêu chuẩn.",
  "expected_state_if_action": "Đảm bảo SLA ổn định mà không phát sinh chi phí xe ngoài.",
  "key_evidence": ${JSON.stringify(evidenceRefs)},
  "uncertainties": [],
  "execution_instruction": "Theo dõi tiến độ xuất hàng tại trạm qua các checkpoint tiếp theo.",
  "required_by": "${requiredBy}",
  "required_followup_at": "${requiredFollowupAt}",
  "estimated_cost_vnd": null,
  "estimated_saving_vnd": null
}

Constraints:
1. "decision_case_id" MUST be "${context.decisionCaseId}".
2. "recommended_action" MUST be one of: ${JSON.stringify(allowed)}.
3. "confidence" MUST be a number between 0 and 1.
4. "key_evidence" MUST cite only valid evidence refs from: ${JSON.stringify(evidenceRefs)}.
5. "estimated_cost_vnd" and "estimated_saving_vnd" MUST both be null.
6. "required_by" and "required_followup_at" MUST be valid ISO timestamps with required_followup_at >= required_by.
7. Missing or unknown operational facts (null or undefined) MUST be treated as UNKNOWN and NEVER inferred as numeric 0.`;

  const response = await generate(prompt, { decisionContext: context }, { temperature: 0, maxTokens: 1000 });
  const clean = response.text.replace(/```json|```/gi, "").trim();
  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  const jsonStr = (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) ? clean.slice(firstBrace, lastBrace + 1) : clean;
  return JSON.parse(jsonStr) as AiRecommendation;
}

function provinceKey(value: string | null | undefined) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").trim().toLocaleLowerCase("vi");
}

/**
 * Phase 2 routes a warehouse as case context, not as a roster-owner lookup.
 * A governed scope must resolve exactly one active Lead and its province topic.
 */
export function selectScopedLeadRecipient(input: {
  scopedManagers: ResolvedRecipient[];
  groups: PilotGroup[];
  topics: PilotTopic[];
  province: string | null;
}): ScopedLeadRecipient | null {
  if (!input.province) return null;
  const leads = input.scopedManagers.filter((member) => member.role === "LEAD" || member.role === "MANAGER");
  if (leads.length !== 1) return null;
  const member = leads[0];
  const group = input.groups.find((item) => item.id === member.groupId && item.status === "ACTIVE");
  if (!group) return null;
  const topic = input.topics.find((item) =>
    item.group_id === group.id && item.status === "ACTIVE" && !item.is_manager_decision &&
    provinceKey(item.province_name) === provinceKey(input.province)
  );
  if (!topic) return null;
  return { member, chatId: String(group.telegram_chat_id), messageThreadId: topic.message_thread_id, province: input.province };
}

/** Keep the governed scope filter ahead of the bounded detector scan. */
export function selectScopedIncidentBatch<T>(incidents: T[], isInGovernedScope: (incident: T) => boolean, limit = 20): T[] {
  return incidents.filter(isInGovernedScope).slice(0, limit);
}

export function parseLeadDetail(value: string): Pick<LeadFact, "expectedIncomingKg" | "expectedIncomingAt" | "incomingType"> | null {
  const matches = Object.fromEntries([...value.matchAll(/\b(KG|ETA|TYPE)\s*=\s*([^;\n]+)/gi)].map((m) => [m[1].toUpperCase(), m[2].trim()]));
  const kg = Number(matches.KG); const type = String(matches.TYPE || "").toUpperCase();
  if (!Number.isFinite(kg) || kg < 0 || !Number.isFinite(Date.parse(String(matches.ETA || ""))) || !["B2B", "ECOM", "MIXED"].includes(type)) return null;
  return { expectedIncomingKg: kg, expectedIncomingAt: String(matches.ETA), incomingType: type as "B2B" | "ECOM" | "MIXED" };
}

function factFrom(answer: IncomingAnswer, actor: string, interactionId: string, detail?: Pick<LeadFact, "expectedIncomingKg" | "expectedIncomingAt" | "incomingType">): LeadFact {
  return { interactionId, suppliedBy: actor, capturedAt: new Date().toISOString(), source: "HUMAN_OPERATIONAL_GROUND_TRUTH", incoming: answer, confidence: answer === "CONFIRMED_ETA" ? "HIGH" : answer === "UNCERTAIN_ETA" ? "MEDIUM" : "LOW", ...detail };
}

/** Adapter is deliberately fail-soft: callers never let Phase 2 affect the Phase 1 checkpoint. */
export class NearTermCapacityRuntimeService {
  constructor(private readonly db: SupabaseClient, private readonly telegram = new TelegramClient()) {}
  private async telemetryWrite(table: string, payload: Record<string, unknown>) {
    try {
      await this.db.from(table).upsert(payload);
    } catch {
      // Telemetry failures are isolated from the business result
    }
  }
  private async writeIncidentTelemetry(context: DetectorTelemetryContext, incident: { incident_key?: string | null; reason_code?: string | null; warehouse_name?: string | null; warehouse_id?: string | null }, facts: CurrentRisk, candidate: boolean, rejectionReason: string | null) {
    await this.telemetryWrite("near_term_capacity_detector_telemetry", {
      checkpoint_at: context.checkpointAt, sync_run_id: context.syncRunId, incident_key: String(incident.incident_key || `${incident.warehouse_id}:${incident.reason_code}`),
      incident_type: String(incident.reason_code || "UNKNOWN"), warehouse: String(incident.warehouse_name || incident.warehouse_id || "UNKNOWN"),
      province: resolveProvince({ warehouseId: String(incident.warehouse_id || ""), warehouse: String(incident.warehouse_name || incident.warehouse_id || "") }) || null,
      affected_order_count: facts.currentOrders, current_kg: facts.currentKg, captured_at_present: Boolean(facts.capturedAt),
      evidence_refs_present: facts.evidenceRefs.length > 0, risk_signals_present: facts.riskSignals.length > 0,
      current_orders_availability: facts.currentOrders == null ? "MISSING" : "AVAILABLE", current_kg_availability: facts.currentKg == null ? "MISSING" : "AVAILABLE",
      backlog_trend_availability: "NOT_USED", new_inflow_availability: "NOT_USED", vehicle_capacity_availability: "NOT_USED",
      manpower_capacity_availability: "NOT_USED", cot_deadline_availability: "NOT_USED", detector_result: candidate ? "CANDIDATE" : "REJECTED", rejection_reason: rejectionReason,
    });
  }
  private async writeCheckpointTelemetry(context: DetectorTelemetryContext, summary: DetectorTelemetrySummary) {
    const completedAt = summary.completedAt;
    await this.telemetryWrite("near_term_capacity_checkpoint_telemetry", {
      checkpoint_at: context.checkpointAt, sync_run_id: context.syncRunId, incidents_available: summary.incidentsAvailable, incidents_scanned: summary.incidentsScanned,
      candidates_detected: summary.candidatesDetected, candidates_persisted: summary.candidatesPersisted, rejected_count: summary.rejectedCount,
      missing_signal_count: summary.missingSignalCount, no_risk_count: summary.noRiskCount, below_threshold_count: summary.belowThresholdCount,
      outside_scope_count: summary.outsideScopeCount, duplicate_count: summary.duplicateCount, active_case_block_count: summary.activeCaseBlockCount,
      other_rejection_count: summary.otherRejectionCount, phase2_started_at: summary.startedAt, phase2_completed_at: completedAt,
      phase2_duration_ms: Math.max(0, Date.parse(completedAt) - Date.parse(summary.startedAt)), updated_at: completedAt,
    });
  }
  private async event(caseId: string, eventType: string, actor: string, payload: Record<string, unknown> = {}) {
    const { error } = await this.db.from("near_term_capacity_events").insert({ case_id: caseId, event_type: eventType, actor, payload });
    if (error) throw error;
  }
  private async activeCase(warehouseId?: string): Promise<CaseRow | null> {
    let query = this.db.from("near_term_capacity_cases").select("*").eq("active", true);
    if (warehouseId && typeof (query as any).eq === "function") {
      query = (query as any).eq("warehouse_id", warehouseId);
    }
    const { data, error } = await (query as any).maybeSingle();
    if (error) throw error;
    return data as CaseRow | null;
  }
  private async getActiveCases(): Promise<CaseRow[]> {
    const query = this.db.from("near_term_capacity_cases").select("*").eq("active", true);
    if (typeof (query as any).then === "function") {
      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as CaseRow[];
    }
    if (typeof (query as any).maybeSingle === "function") {
      const { data, error } = await (query as any).maybeSingle();
      if (error) throw error;
      return data ? [data as CaseRow] : [];
    }
    return [];
  }
  private async activeCaseById(caseId: string): Promise<CaseRow | null> {
    const query = this.db.from("near_term_capacity_cases").select("*").eq("id", caseId);
    if (typeof (query as any).eq === "function") {
      const activeQuery = (query as any).eq("active", true);
      if (typeof activeQuery.maybeSingle === "function") {
        const { data, error } = await activeQuery.maybeSingle();
        if (error) throw error;
        return data as CaseRow | null;
      }
    }
    if (typeof (query as any).maybeSingle === "function") {
      const { data, error } = await (query as any).maybeSingle();
      if (error) throw error;
      return data as CaseRow | null;
    }
    const single = await this.activeCase();
    if (single && single.id === caseId) return single;
    return null;
  }
  private async claimUnsentFactRequest(caseId: string) {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data, error } = await this.db.from("near_term_capacity_cases")
      .update({ fact_request_delivery_claimed_at: new Date().toISOString() })
      .eq("id", caseId).eq("active", true).eq("status", "FACT_REQUESTED")
      .or(`fact_request_delivery_claimed_at.is.null,fact_request_delivery_claimed_at.lt.${cutoff}`)
      .select("id").maybeSingle();
    if (error) throw error;
    return Boolean(data?.id);
  }
  private async clearFactRequestClaim(caseId: string) {
    await this.db.from("near_term_capacity_cases").update({ fact_request_delivery_claimed_at: null }).eq("id", caseId);
  }
  private async resumeUnsentFactRequest(row: CaseRow, actor: string) {
    const [{ data: sentEvent, error: sentError }, { data: factResponse, error: factError }] = await Promise.all([
      this.db.from("near_term_capacity_events").select("id").eq("case_id", row.id).eq("event_type", "FACT_REQUEST_SENT").maybeSingle(),
      this.db.from("near_term_capacity_fact_responses").select("id").eq("case_id", row.id).maybeSingle(),
    ]);
    if (sentError || factError) throw sentError || factError;
    if (!isRecoverableUnsentFactRequest(row, sentEvent, factResponse) || !(await this.claimUnsentFactRequest(row.id))) return false;
    try {
      const recipient = await this.recipient(row.warehouse_id, row.warehouse_name);
      if (!recipient) { await this.clearFactRequestClaim(row.id); return false; }
      const facts = row.current_risk_snapshot;
      const keyboard = nearTermFactButtons.map(([text, answer]) => [{ text, callbackData: buildNearTermFactCallbackData(row.id, answer) }]);
      const sent = await this.telegram.sendToChat(recipient.chatId, formatNearTermFactRequest(facts, policy.nearTermWindowMinutes), { inlineKeyboard: keyboard, messageThreadId: recipient.messageThreadId });
      await this.event(row.id, "FACT_REQUEST_SENT", actor, { interactionId: row.id, telegramMessageId: sent.messageId, memberId: recipient.member.memberId, messageThreadId: recipient.messageThreadId, province: recipient.province, mode: NEAR_TERM_SHADOW_MODE });
      await this.clearFactRequestClaim(row.id);
      return true;
    } catch (error) {
      await this.clearFactRequestClaim(row.id);
      throw error;
    }
  }
  private async recipient(warehouseId: string, warehouseName: string, resolvedScope?: ScopeResolutionResult) {
    const scope = resolvedScope || await resolveAuthorizedRecipients(this.db, { warehouseId, warehouse: warehouseName });
    if (scope.quarantine || !scope.managers.length) return null;
    const province = resolveProvince({ warehouseId, warehouse: warehouseName });
    const groupIds = [...new Set(scope.managers.map((member) => member.groupId))];
    const [{ data: groups, error: groupError }, { data: topics, error: topicError }] = await Promise.all([
      this.db.from("telegram_pilot_groups").select("id,telegram_chat_id,status").in("id", groupIds).eq("status", "ACTIVE"),
      this.db.from("telegram_pilot_topics").select("group_id,message_thread_id,province_name,is_manager_decision,status").in("group_id", groupIds).eq("status", "ACTIVE"),
    ]);
    if (groupError || topicError) throw groupError || topicError;
    return selectScopedLeadRecipient({ scopedManagers: scope.managers, groups: (groups || []) as PilotGroup[], topics: (topics || []) as PilotTopic[], province });
  }
  /** Existing persisted KHO_TON incident/history are evidence, not a made-up capacity threshold. */
  async runCheckpoint(actor = "near_term_capacity_checkpoint", telemetryContext?: DetectorTelemetryContext) {
    const startedAt = new Date().toISOString();
    const summary: DetectorTelemetrySummary = {
      incidentsAvailable: 0, incidentsScanned: 0, candidatesDetected: 0, candidatesPersisted: 0,
      rejectedCount: 0, missingSignalCount: 0, noRiskCount: 0, belowThresholdCount: 0,
      outsideScopeCount: 0, duplicateCount: 0, activeCaseBlockCount: 0, otherRejectionCount: 0,
      startedAt, completedAt: startedAt,
    };
    const finish = async <T>(result: T) => {
      if (telemetryContext) {
        summary.completedAt = new Date().toISOString();
        await this.writeCheckpointTelemetry(telemetryContext, summary);
      }
      return result;
    };

    const multiEnabled = isMultiWarehouseEnabled();
    const activeCases = await this.getActiveCases();

    // 1. Recover unsent fact requests on any active case
    for (const activeRow of activeCases) {
      if (activeRow.status === "FACT_REQUESTED" && await this.resumeUnsentFactRequest(activeRow, actor)) {
        return finish({ status: "FACT_REQUEST_SENT", risk_candidates: 1, fact_requests_sent: 1, caseId: activeRow.id, recovered: true });
      }
    }

    // 2. Kill switch or legacy global lock mode
    if (!multiEnabled && activeCases.length > 0) {
      summary.activeCaseBlockCount = 1;
      return finish({ status: "ACTIVE_CASE_EXISTS", risk_candidates: 0, fact_requests_sent: 0 });
    }

    // If an active case row lacks warehouse_id (test mock / legacy single case), treat as global active lock
    if (activeCases.some((c) => !c.warehouse_id)) {
      summary.activeCaseBlockCount = 1;
      return finish({ status: "ACTIVE_CASE_EXISTS", risk_candidates: 0, fact_requests_sent: 0 });
    }

    const activeWarehouseIds = new Set(activeCases.map((c) => String(c.warehouse_id || "")).filter(Boolean));

    // 3. 24-hour Cooldown query: warehouses with a case created in the past 24h
    let cooldownWarehouseIds = new Set<string>();
    try {
      const cutoff24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { data: recentCases } = await this.db
        .from("near_term_capacity_cases")
        .select("warehouse_id")
        .gte("created_at", cutoff24h);
      if (recentCases) {
        cooldownWarehouseIds = new Set(recentCases.map((r) => String(r.warehouse_id || "")).filter(Boolean));
      }
    } catch {
      // Fail-soft if query unsupported in test mocks
    }

    const { data: incidents, error } = await this.db
      .from("incidents")
      .select("id,incident_key,warehouse_id,warehouse_name,reason_code,last_detected_at")
      .in("status", ["open", "monitoring"])
      .eq("reason_code", "KHO_TON")
      .order("last_detected_at", { ascending: false });
    if (error) throw error;

    const scopeByIncident = new Map<string, ScopeResolutionResult>();
    for (const incident of incidents || []) {
      const warehouseId = String(incident.warehouse_id || "");
      const warehouseName = String(incident.warehouse_name || incident.warehouse_id || "");
      const scopeKey = `${warehouseId}:${warehouseName}`;
      if (!scopeByIncident.has(scopeKey)) {
        scopeByIncident.set(scopeKey, await resolveAuthorizedRecipients(this.db, { warehouseId, warehouse: warehouseName }));
      }
    }

    const scopedIncidents = selectScopedIncidentBatch(incidents || [], (incident) => {
      const scope = scopeByIncident.get(`${String(incident.warehouse_id || "")}:${String(incident.warehouse_name || incident.warehouse_id || "")}`);
      return Boolean(scope && !scope.quarantine && scope.managers.length);
    });

    summary.incidentsAvailable = scopedIncidents.length;
    summary.incidentsScanned = scopedIncidents.length;

    type CandidateEntry = {
      facts: CurrentRisk;
      incident: (typeof scopedIncidents)[number];
      recipient: ScopedLeadRecipient;
    };
    const eligiblePilotCandidates: CandidateEntry[] = [];
    let hadPilotActiveBlock = false;

    for (const incident of scopedIncidents) {
      const { data: history, error: historyError } = await this.db
        .from("incident_history")
        .select("affected_order_count,recorded_at,sync_run_id")
        .eq("incident_id", incident.id)
        .order("recorded_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (historyError) throw historyError;

      let orderCodes: string[] = [];
      let currentKg: number | null = null;
      if (history?.sync_run_id) {
        const { data: orders, error: orderError } = await this.db
          .from("order_snapshots")
          .select("order_code,weight_kg")
          .eq("sync_run_id", history.sync_run_id)
          .eq("warehouse_id", String(incident.warehouse_id))
          .eq("reason_code", "KHO_TON");
        if (orderError) throw orderError;
        orderCodes = (orders || []).map((order) => String(order.order_code || "")).filter(Boolean);
        const weights = (orders || []).map((order) => Number(order.weight_kg)).filter((weight) => Number.isFinite(weight) && weight >= 0);
        if (weights.length === (orders || []).length && weights.length > 0) {
          currentKg = weights.reduce((total, weight) => total + weight, 0);
        }
      }

      const facts: CurrentRisk = {
        warehouseId: String(incident.warehouse_id),
        warehouseName: String(incident.warehouse_name || incident.warehouse_id),
        capturedAt: history?.recorded_at || incident.last_detected_at,
        currentOrders: history?.affected_order_count ?? null,
        currentKg,
        b2bOrders: null,
        orderCodes,
        evidenceRefs: [`incident:${incident.id}`, ...(history ? [`incident_history:${history.recorded_at}`] : [])],
        riskSignals: ["KHO_TON"],
        hardSlaConstraint: "Persisted warehouse backlog risk",
      };

      const candidate = detectCandidate(facts);
      if (telemetryContext) {
        await this.writeIncidentTelemetry(telemetryContext, incident, facts, candidate, candidate ? null : "MISSING_REQUIRED_SIGNAL");
      }
      if (!candidate) {
        summary.rejectedCount += 1;
        summary.missingSignalCount += 1;
        continue;
      }
      summary.candidatesDetected += 1;

      // Observe in live shadow (fail-soft via logger)
      void new NearTermCapacityShadowService(this.db).observeLiveCandidate({
        checkpointAt: facts.capturedAt,
        syncRunId: telemetryContext?.syncRunId || "live-checkpoint",
        incidentKey: String(incident.incident_key || `${facts.warehouseId}:KHO_TON`),
        warehouse: facts.warehouseName,
        warehouseId: facts.warehouseId,
        province: resolveProvince({ warehouseId: facts.warehouseId, warehouse: facts.warehouseName }),
        affectedOrderCount: facts.currentOrders,
        currentKg: facts.currentKg,
        evidenceRefs: facts.evidenceRefs,
        riskSignals: facts.riskSignals,
      }).catch((e) => logger.warn("Live shadow observation failed fail-soft:", { error: e }));

      // GATING 1: Non-pilot warehouses remain strictly shadow-only
      if (!isStage1PilotWarehouse(facts.warehouseId)) {
        summary.outsideScopeCount += 1;
        continue;
      }

      // GATING 2: Active Case Suppression (Per-warehouse concurrency)
      if (activeWarehouseIds.has(facts.warehouseId)) {
        summary.activeCaseBlockCount += 1;
        hadPilotActiveBlock = true;
        continue;
      }

      // GATING 3: 24h Warehouse Cooldown
      if (cooldownWarehouseIds.has(facts.warehouseId)) {
        summary.duplicateCount += 1;
        continue;
      }

      // GATING 4: Scoped Lead Recipient Resolution
      const resolvedScope = scopeByIncident.get(`${facts.warehouseId}:${facts.warehouseName}`);
      const recipient = await this.recipient(facts.warehouseId, facts.warehouseName, resolvedScope);
      if (!recipient) {
        summary.outsideScopeCount += 1;
        continue;
      }

      eligiblePilotCandidates.push({ facts, incident, recipient });
    }

    if (eligiblePilotCandidates.length === 0) {
      if (hadPilotActiveBlock) {
        return finish({ status: "ACTIVE_CASE_EXISTS", risk_candidates: summary.candidatesDetected, fact_requests_sent: 0 });
      }
      return finish({ status: "NO_CANDIDATE", risk_candidates: summary.candidatesDetected, fact_requests_sent: 0 });
    }

    // CADENCE LIMIT: At most 1 NEW governed case per checkpoint execution.
    // Deterministic ranking: highest affected orders first, tie-break on warehouseId ascending.
    eligiblePilotCandidates.sort((a, b) => {
      const ordersA = a.facts.currentOrders ?? 0;
      const ordersB = b.facts.currentOrders ?? 0;
      if (ordersB !== ordersA) return ordersB - ordersA;
      return a.facts.warehouseId.localeCompare(b.facts.warehouseId);
    });

    const selected = eligiblePilotCandidates[0];

    const { data: created, error: createError } = await this.db
      .from("near_term_capacity_cases")
      .insert({
        warehouse_id: selected.facts.warehouseId,
        warehouse_name: selected.facts.warehouseName,
        current_risk_snapshot: selected.facts,
        status: "FACT_REQUESTED",
        active: true,
      })
      .select("*")
      .single();

    if (createError) {
      if (createError.code === "23505") {
        summary.duplicateCount += 1;
        return finish({ status: "ACTIVE_CASE_EXISTS", risk_candidates: summary.candidatesDetected, fact_requests_sent: 0 });
      }
      throw createError;
    }

    summary.candidatesPersisted += 1;
    const caseRow = created as CaseRow;

    if (isMultiOptionShadowEnabled()) {
      void new NearTermCapacityMultiOptionShadowService(this.db)
        .evaluateShadow(caseRow.id, selected.facts, null)
        .catch((e) => logger.warn("Multi-option shadow evaluation failed at checkpoint:", { error: e }));
    }

    const keyboard = nearTermFactButtons.map(([text, answer]) => [{
      text,
      callbackData: buildNearTermFactCallbackData(caseRow.id, answer),
    }]);

    try {
      const sent = await this.telegram.sendToChat(
        selected.recipient.chatId,
        formatNearTermFactRequest(selected.facts, policy.nearTermWindowMinutes),
        { inlineKeyboard: keyboard, messageThreadId: selected.recipient.messageThreadId }
      );
      await this.event(caseRow.id, "FACT_REQUEST_SENT", actor, {
        interactionId: caseRow.id,
        telegramMessageId: sent.messageId,
        memberId: selected.recipient.member.memberId,
        messageThreadId: selected.recipient.messageThreadId,
        province: selected.recipient.province,
        mode: NEAR_TERM_SHADOW_MODE,
      });
      return finish({
        status: "FACT_REQUEST_SENT",
        risk_candidates: summary.candidatesDetected,
        fact_requests_sent: 1,
        caseId: caseRow.id,
      });
    } catch (sendError) {
      await this.event(caseRow.id, "FACT_REQUEST_SEND_FAILED", actor, {
        reason: sendError instanceof Error ? sendError.message : String(sendError),
      });
      throw sendError;
    }
  }
  async consumeInitialAnswer(
    caseId: string,
    answer: NearTermFactAnswer,
    memberId: string,
    chatId: string,
    messageId: number,
    updateId: number,
    responderInfo?: {
      displayName?: string;
      role?: string;
      capturedAt?: string | Date;
      originalText?: string;
    }
  ) {
    const row = await this.activeCaseById(caseId);
    if (!row || row.status !== "FACT_REQUESTED") return { status: "ALREADY_RESPONDED" as const };
    const { data: event } = await this.db.from("near_term_capacity_events").select("id,payload").eq("case_id", caseId).eq("event_type", "FACT_REQUEST_SENT").maybeSingle();
    if (!event || String(event.payload?.telegramMessageId) !== String(messageId) || String(event.payload?.memberId) !== memberId) return { status: "INVALID_TARGET" as const };
    const incoming = answer as IncomingAnswer;
    await this.event(caseId, "FACT_INITIAL_RESPONSE_RECEIVED", `telegram:${memberId}`, { interactionId: caseId, answer, chatId, messageId, updateId });

    try {
      const originalText = responderInfo?.originalText || formatNearTermFactRequest(row.current_risk_snapshot, policy.nearTermWindowMinutes);
      const confirmationText = formatNearTermFactConfirmation(originalText, {
        answer,
        responderName: responderInfo?.displayName || "Lead kho",
        responderRole: responderInfo?.role,
        answeredAt: responderInfo?.capturedAt || new Date(),
      });
      await this.telegram.editMessageText(chatId, messageId, confirmationText, { inlineKeyboard: [] });
    } catch (editError) {
      logger.warn("Failed to edit Telegram message with fact confirmation (fail-soft)", {
        caseId,
        messageId,
        chatId,
        error: editError instanceof Error ? editError.message : String(editError),
      });
    }

    if (answer === "CONFIRMED_ETA" || answer === "UNCERTAIN_ETA") {
      const { error } = await this.db.from("near_term_capacity_cases").update({ status: "FACT_CAPTURED", updated_at: new Date().toISOString() }).eq("id", caseId).eq("status", "FACT_REQUESTED");
      if (error) throw error;
      const sent = await this.telegram.sendToChat(chatId, formatNearTermDetailRequest());
      await this.event(caseId, "FACT_DETAIL_REQUEST_SENT", "near_term_capacity", { telegramMessageId: sent.messageId, interactionId: `${caseId}:detail`, answer });
      return { status: "DETAIL_REQUESTED" as const };
    }
    return this.persistAndDecide(row, factFrom(incoming, `telegram:${memberId}`, caseId));
  }
  async consumeDetailReply(caseId: string, memberId: string, text: string) {
    const row = await this.activeCaseById(caseId);
    if (!row || row.status !== "FACT_CAPTURED") return { status: "NOT_AWAITING_DETAILS" as const };
    const initial = await this.db.from("near_term_capacity_events").select("payload").eq("case_id", caseId).eq("event_type", "FACT_INITIAL_RESPONSE_RECEIVED").maybeSingle();
    const answer = initial.data?.payload?.answer as IncomingAnswer | undefined;
    const detail = parseLeadDetail(text);
    if (!answer || !detail) return { status: "INVALID_DETAIL" as const };
    return this.persistAndDecide(row, factFrom(answer, `telegram:${memberId}`, `${caseId}:detail`, detail));
  }
  async consumeDetailFromTelegramReply(memberId: string, replyToMessageId: number, text: string) {
    const { data: detailEvents } = await this.db.from("near_term_capacity_events").select("case_id,payload").eq("event_type", "FACT_DETAIL_REQUEST_SENT");
    const matching = (detailEvents || []).find((e) => Number(e.payload?.telegramMessageId) === replyToMessageId);
    let targetCaseId = matching?.case_id;
    if (!targetCaseId) {
      const activeRows = await this.getActiveCases();
      const captured = activeRows.find((r) => r.status === "FACT_CAPTURED");
      if (captured) targetCaseId = captured.id;
    }
    if (!targetCaseId) return { handled: false };
    const row = await this.activeCaseById(targetCaseId);
    if (!row || row.status !== "FACT_CAPTURED") return { handled: false };
    return { handled: true, ...(await this.consumeDetailReply(row.id, memberId, text)) };
  }
  private async persistAndDecide(row: CaseRow, lead: LeadFact) {
    const { error: factError } = await this.db.from("near_term_capacity_fact_responses").insert({ case_id: row.id, interaction_id: lead.interactionId, supplied_by: lead.suppliedBy, captured_at: lead.capturedAt, source: lead.source, payload: lead });
    if (factError?.code === "23505") return { status: "ALREADY_RESPONDED" as const };
    if (factError) throw factError;
    await this.db.from("near_term_capacity_cases").update({ lead_fact_snapshot: lead, status: "FACT_CAPTURED", updated_at: new Date().toISOString() }).eq("id", row.id);
    await this.event(row.id, "FACT_RECEIVED", lead.suppliedBy, { interactionId: lead.interactionId });
    const context = buildContext(row.id, row.current_risk_snapshot, lead, policy);
    if (context.uncertainties.length) { await this.db.from("near_term_capacity_cases").update({ decision_context: context, status: "HUMAN_INVESTIGATION_REQUIRED" }).eq("id", row.id); await this.event(row.id, "HUMAN_INVESTIGATION_REQUIRED", "near_term_capacity", { reasons: context.uncertainties }); return { status: "HUMAN_INVESTIGATION_REQUIRED" as const }; }
    let ai: AiRecommendation;
    try {
      ai = await callAiRecommendation(context);
    } catch (error) {
      await this.db.from("near_term_capacity_cases").update({ decision_context: context, status: "HUMAN_INVESTIGATION_REQUIRED" }).eq("id", row.id);
      await this.event(row.id, "AI_DECISION_FAILED", "near_term_capacity", { reason: error instanceof Error ? error.message : String(error) });
      return { status: "HUMAN_INVESTIGATION_REQUIRED" as const };
    }
    const critic = critique(context, ai); const status = critic.verdict === "VALID_DECISION" ? "DECISION_READY" : "HUMAN_INVESTIGATION_REQUIRED";
    await this.db.from("near_term_capacity_cases").update({ decision_context: context, ai_recommendation: ai, critic_result: critic, status, updated_at: new Date().toISOString() }).eq("id", row.id);
    await this.event(row.id, critic.verdict === "VALID_DECISION" ? "AI_DECISION_CREATED" : "HUMAN_INVESTIGATION_REQUIRED", "near_term_capacity", { critic, mode: NEAR_TERM_SHADOW_MODE });
    if (isMultiOptionShadowEnabled()) {
      void new NearTermCapacityMultiOptionShadowService(this.db)
        .evaluateShadow(row.id, row.current_risk_snapshot, lead)
        .catch((e) => logger.warn("Multi-option shadow evaluation failed at persistAndDecide:", { error: e }));
    }
    if (critic.verdict === "VALID_DECISION" && ai.recommended_action !== "HUMAN_INVESTIGATION_REQUIRED") {
      await new NearTermCapacityDecisionBridge(this.db).createAndDispatch({ ...row, lead_fact_snapshot: lead, decision_context: context, ai_recommendation: ai, critic_result: critic }, "near_term_capacity");
    }
    return { status, recommendation: critic.verdict === "VALID_DECISION" ? ai.recommended_action : null };
  }
  async resumeInvestigationAiDecision(caseId: string, actor = "near_term_capacity_recovery") {
    const { data: row, error } = await this.db.from("near_term_capacity_cases").select("*").eq("id", caseId).eq("active", true).maybeSingle();
    if (error) throw error;
    if (!row) return { status: "CASE_NOT_FOUND" as const, caseId };

    if (row.status === "DECISION_READY" || row.decision_id) {
      return { status: "ALREADY_DECIDED" as const, caseId: row.id, decisionId: row.decision_id, recommendation: row.ai_recommendation?.recommended_action ?? null };
    }

    if (row.status !== "HUMAN_INVESTIGATION_REQUIRED") {
      return { status: "NOT_IN_RECOVERABLE_STATE" as const, caseId: row.id, currentStatus: row.status };
    }

    const lead = row.lead_fact_snapshot as LeadFact | null;
    if (!lead) {
      return { status: "MISSING_LEAD_FACT" as const, caseId: row.id };
    }

    const referenceTime = lead?.capturedAt ? new Date(lead.capturedAt) : new Date();
    const context = (row.decision_context && Array.isArray(row.decision_context.uncertainties) && row.decision_context.uncertainties.length === 0)
      ? row.decision_context
      : buildContext(row.id, row.current_risk_snapshot, lead, policy, referenceTime);
    if (context.uncertainties.length) {
      await this.db.from("near_term_capacity_cases").update({ decision_context: context, updated_at: new Date().toISOString() }).eq("id", row.id);
      await this.event(row.id, "HUMAN_INVESTIGATION_REQUIRED", actor, { reasons: context.uncertainties });
      return { status: "HUMAN_INVESTIGATION_REQUIRED" as const, uncertainties: context.uncertainties };
    }

    await this.event(row.id, "AI_DECISION_RESUME_STARTED", actor, { interactionId: row.id });

    let ai: AiRecommendation;
    try {
      ai = await callAiRecommendation(context);
    } catch (error) {
      await this.db.from("near_term_capacity_cases").update({ decision_context: context, updated_at: new Date().toISOString() }).eq("id", row.id);
      await this.event(row.id, "AI_DECISION_FAILED", actor, { reason: error instanceof Error ? error.message : String(error) });
      return { status: "HUMAN_INVESTIGATION_REQUIRED" as const, error: error instanceof Error ? error.message : String(error) };
    }

    const critic = critique(context, ai);
    const status = critic.verdict === "VALID_DECISION" ? "DECISION_READY" : "HUMAN_INVESTIGATION_REQUIRED";
    await this.db.from("near_term_capacity_cases").update({ decision_context: context, ai_recommendation: ai, critic_result: critic, status, updated_at: new Date().toISOString() }).eq("id", row.id);
    await this.event(row.id, critic.verdict === "VALID_DECISION" ? "AI_DECISION_CREATED" : "HUMAN_INVESTIGATION_REQUIRED", actor, { critic, mode: NEAR_TERM_SHADOW_MODE });
    if (isMultiOptionShadowEnabled()) {
      void new NearTermCapacityMultiOptionShadowService(this.db)
        .evaluateShadow(row.id, row.current_risk_snapshot, lead)
        .catch((e) => logger.warn("Multi-option shadow evaluation failed at resume:", { error: e }));
    }

    let bridgeResult: unknown = null;
    if (critic.verdict === "VALID_DECISION" && ai.recommended_action !== "HUMAN_INVESTIGATION_REQUIRED") {
      bridgeResult = await new NearTermCapacityDecisionBridge(this.db, this.telegram).createAndDispatch({ ...row, lead_fact_snapshot: lead, decision_context: context, ai_recommendation: ai, critic_result: critic }, actor);
    }
    return { status, caseId: row.id, recommendation: critic.verdict === "VALID_DECISION" ? ai.recommended_action : null, criticVerdict: critic.verdict, bridgeResult };
  }
}
