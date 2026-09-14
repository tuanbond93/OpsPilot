import type { SupabaseClient } from "@supabase/supabase-js";
import { generate } from "@/ai/provider";
import { buildContext, critique, detectCandidate, type AiRecommendation, type CurrentRisk, type IncomingAnswer, type LeadFact } from "@/domain/near-term-capacity";
import { TelegramClient } from "@/integrations/telegram/telegram-client";
import { buildNearTermFactCallbackData, formatNearTermDetailRequest, formatNearTermFactRequest, nearTermFactButtons, type NearTermFactAnswer } from "@/integrations/telegram/near-term-capacity-message";
import { NearTermCapacityDecisionBridge } from "@/services/near-term-capacity-decision-bridge";
import { resolveAuthorizedRecipients, resolveProvince, type ResolvedRecipient } from "@/notifications/gateway/scope-resolver";

export const NEAR_TERM_SHADOW_MODE = "SHADOW_DECISION_WITH_LIVE_FACT_COLLECTION" as const;
const policy = { nearTermWindowMinutes: 240, leadFactMaxAgeMinutes: 60, allowedActions: ["NO_ACTION_MONITOR", "ADD_VEHICLE", "HOLD_LOW_PRIORITY_ECOM", "ADD_MANPOWER", "REALLOCATE_AVAILABLE_CAPACITY", "HUMAN_INVESTIGATION_REQUIRED"] as const };
type CaseRow = { id: string; warehouse_id: string; warehouse_name: string; current_risk_snapshot: CurrentRisk; lead_fact_snapshot: LeadFact | null; status: string; active: boolean };
type PilotGroup = { id: string; telegram_chat_id: string | number; status: string };
type PilotTopic = { group_id: string; message_thread_id: number; province_name: string | null; is_manager_decision: boolean; status: string };
type ScopedLeadRecipient = { member: ResolvedRecipient; chatId: string; messageThreadId: number; province: string };

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
  private async event(caseId: string, eventType: string, actor: string, payload: Record<string, unknown> = {}) {
    const { error } = await this.db.from("near_term_capacity_events").insert({ case_id: caseId, event_type: eventType, actor, payload });
    if (error) throw error;
  }
  private async activeCase(): Promise<CaseRow | null> {
    const { data, error } = await this.db.from("near_term_capacity_cases").select("*").eq("active", true).maybeSingle();
    if (error) throw error; return data as CaseRow | null;
  }
  private async recipient(warehouseId: string, warehouseName: string) {
    const scope = await resolveAuthorizedRecipients(this.db, { warehouseId, warehouse: warehouseName });
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
  async runCheckpoint(actor = "near_term_capacity_checkpoint") {
    if (await this.activeCase()) return { status: "ACTIVE_CASE_EXISTS", risk_candidates: 0, fact_requests_sent: 0 };
    const { data: incidents, error } = await this.db.from("incidents").select("id,warehouse_id,warehouse_name,reason_code,last_detected_at").in("status", ["open", "monitoring"]).eq("reason_code", "KHO_TON").order("last_detected_at", { ascending: false }).limit(20);
    if (error) throw error;
    for (const incident of incidents || []) {
      const { data: history, error: historyError } = await this.db.from("incident_history").select("affected_order_count,recorded_at").eq("incident_id", incident.id).order("recorded_at", { ascending: false }).limit(1).maybeSingle();
      if (historyError) throw historyError;
      const facts: CurrentRisk = { warehouseId: String(incident.warehouse_id), warehouseName: String(incident.warehouse_name || incident.warehouse_id), capturedAt: history?.recorded_at || incident.last_detected_at, currentOrders: history?.affected_order_count ?? null, currentKg: null, b2bOrders: null, evidenceRefs: [`incident:${incident.id}`, ...(history ? [`incident_history:${history.recorded_at}`] : [])], riskSignals: ["KHO_TON"], hardSlaConstraint: "Persisted warehouse backlog risk" };
      if (!detectCandidate(facts)) continue;
      const recipient = await this.recipient(facts.warehouseId, facts.warehouseName); if (!recipient) continue;
      const { data: created, error: createError } = await this.db.from("near_term_capacity_cases").insert({ warehouse_id: facts.warehouseId, warehouse_name: facts.warehouseName, current_risk_snapshot: facts, status: "FACT_REQUESTED", active: true }).select("*").single();
      if (createError) { if (createError.code === "23505") return { status: "ACTIVE_CASE_EXISTS", risk_candidates: 1, fact_requests_sent: 0 }; throw createError; }
      const caseRow = created as CaseRow; const keyboard = nearTermFactButtons.map(([text, answer]) => [{ text, callbackData: buildNearTermFactCallbackData(caseRow.id, answer) }]);
      try {
        const sent = await this.telegram.sendToChat(recipient.chatId, formatNearTermFactRequest(facts, policy.nearTermWindowMinutes), { inlineKeyboard: keyboard, messageThreadId: recipient.messageThreadId });
        await this.event(caseRow.id, "FACT_REQUEST_SENT", actor, { interactionId: caseRow.id, telegramMessageId: sent.messageId, memberId: recipient.member.memberId, messageThreadId: recipient.messageThreadId, province: recipient.province, mode: NEAR_TERM_SHADOW_MODE });
        return { status: "FACT_REQUEST_SENT", risk_candidates: 1, fact_requests_sent: 1, caseId: caseRow.id };
      } catch (sendError) { await this.event(caseRow.id, "FACT_REQUEST_SEND_FAILED", actor, { reason: sendError instanceof Error ? sendError.message : String(sendError) }); throw sendError; }
    }
    return { status: "NO_CANDIDATE", risk_candidates: 0, fact_requests_sent: 0 };
  }
  async consumeInitialAnswer(caseId: string, answer: NearTermFactAnswer, memberId: string, chatId: string, messageId: number, updateId: number) {
    const row = await this.activeCase();
    if (!row || row.id !== caseId || row.status !== "FACT_REQUESTED") return { status: "ALREADY_RESPONDED" as const };
    const { data: event } = await this.db.from("near_term_capacity_events").select("id,payload").eq("case_id", caseId).eq("event_type", "FACT_REQUEST_SENT").maybeSingle();
    if (!event || String(event.payload?.telegramMessageId) !== String(messageId) || String(event.payload?.memberId) !== memberId) return { status: "INVALID_TARGET" as const };
    const incoming = answer as IncomingAnswer;
    await this.event(caseId, "FACT_INITIAL_RESPONSE_RECEIVED", `telegram:${memberId}`, { interactionId: caseId, answer, chatId, messageId, updateId });
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
    const row = await this.activeCase(); if (!row || row.id !== caseId || row.status !== "FACT_CAPTURED") return { status: "NOT_AWAITING_DETAILS" as const };
    const initial = await this.db.from("near_term_capacity_events").select("payload").eq("case_id", caseId).eq("event_type", "FACT_INITIAL_RESPONSE_RECEIVED").maybeSingle();
    const answer = initial.data?.payload?.answer as IncomingAnswer | undefined; const detail = parseLeadDetail(text);
    if (!answer || !detail) return { status: "INVALID_DETAIL" as const };
    return this.persistAndDecide(row, factFrom(answer, `telegram:${memberId}`, `${caseId}:detail`, detail));
  }
  async consumeDetailFromTelegramReply(memberId: string, replyToMessageId: number, text: string) {
    const row = await this.activeCase(); if (!row || row.status !== "FACT_CAPTURED") return { handled: false };
    const { data: detailEvent, error } = await this.db.from("near_term_capacity_events").select("payload").eq("case_id", row.id).eq("event_type", "FACT_DETAIL_REQUEST_SENT").maybeSingle();
    if (error) throw error;
    if (Number(detailEvent?.payload?.telegramMessageId) !== replyToMessageId) return { handled: false };
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
    try { const response = await generate("Return only the Phase 2 AiRecommendation JSON. Choose one allowed action, cite only evidence refs, and set both financial values null.", { decisionContext: context }, { temperature: 0, maxTokens: 1000 }); ai = JSON.parse(response.text.replace(/```json|```/gi, "").trim()) as AiRecommendation; }
    catch (error) { await this.db.from("near_term_capacity_cases").update({ decision_context: context, status: "HUMAN_INVESTIGATION_REQUIRED" }).eq("id", row.id); await this.event(row.id, "AI_DECISION_FAILED", "near_term_capacity", { reason: error instanceof Error ? error.message : String(error) }); return { status: "HUMAN_INVESTIGATION_REQUIRED" as const }; }
    const critic = critique(context, ai); const status = critic.verdict === "VALID_DECISION" ? "DECISION_READY" : "HUMAN_INVESTIGATION_REQUIRED";
    await this.db.from("near_term_capacity_cases").update({ decision_context: context, ai_recommendation: ai, critic_result: critic, status, updated_at: new Date().toISOString() }).eq("id", row.id);
    await this.event(row.id, critic.verdict === "VALID_DECISION" ? "AI_DECISION_CREATED" : "HUMAN_INVESTIGATION_REQUIRED", "near_term_capacity", { critic, mode: NEAR_TERM_SHADOW_MODE });
    if (critic.verdict === "VALID_DECISION" && ai.recommended_action !== "HUMAN_INVESTIGATION_REQUIRED") {
      await new NearTermCapacityDecisionBridge(this.db).createAndDispatch({ ...row, lead_fact_snapshot: lead, decision_context: context, ai_recommendation: ai, critic_result: critic }, "near_term_capacity");
    }
    return { status, recommendation: critic.verdict === "VALID_DECISION" ? ai.recommended_action : null };
  }
}
