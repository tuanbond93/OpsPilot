import { createHash } from "crypto";
import { TelegramClient } from "@/integrations/telegram/telegram-client";
import { buildDecisionMessage } from "@/integrations/telegram/decision-message";
import { SecretProvider } from "@/integrations/secrets";
import type { Decision } from "@/domain/decision";

export function sourceFingerprint(value: unknown): string {
  const normalize = (item: any): any => Array.isArray(item) ? item.map(normalize) : item && typeof item === "object" ? Object.keys(item).sort().reduce((out: Record<string, any>, key) => { out[key] = normalize(item[key]); return out; }, {}) : item;
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

export function decisionSourceSnapshot(input: { incident: any; triage: any; planner: any; history: any }) {
  return {
    incident: {
      id: input.incident.id,
      key: input.incident.incident_key ?? input.incident.key,
      updatedAt: input.incident.updated_at ?? input.incident.updatedAt ?? input.incident.last_detected_at,
      status: input.incident.status,
    },
    triage: input.triage ? {
      route: input.triage.route,
      createdAt: input.triage.created_at ?? input.triage.createdAt,
      evidence: input.triage.evidence,
    } : null,
    planner: input.planner ? { id: input.planner.id, result: input.planner.result } : null,
    history: input.history || null,
  };
}

/** Telegram adapter: it never calls DecisionService.transition or execution APIs. */
export class DecisionTelegramShadowService {
  constructor(private readonly client: TelegramClient = new TelegramClient()) {}
  async dispatch(input: { requestId: string; chatId: string; messageThreadId: number; incident: string; finalDecision: string; why: string; expectedOutcome: string; keyEvidence: string[]; risks: string[]; confidence: number }) {
    if (!input.chatId.trim() || !Number.isSafeInteger(input.messageThreadId) || input.messageThreadId <= 0) throw new Error("MANAGER_DECISION_TOPIC_NOT_CONFIGURED");
    const message = buildDecisionMessage(input);
    return this.client.sendToChat(input.chatId, message.text, { inlineKeyboard: message.inlineKeyboard, messageThreadId: input.messageThreadId });
  }
}

export type ManagerDecisionDestination = { chatId: string; messageThreadId: number; scopeCode: string };

/**
 * The admin callback fixture deliberately has no incident, triage, planner or
 * history rows. It must not be evaluated with the production freshness query,
 * because there is no operational source state that could become stale. This
 * exception is narrowly limited to the explicitly-labelled synthetic test
 * source; all real Level C decisions still require a fresh source fingerprint.
 */
export function isSyntheticTelegramShadowTest(sourceLinks: Pick<Decision["sourceLinks"], "sourceType">): boolean {
  return sourceLinks.sourceType === "TELEGRAM_SHADOW_TEST";
}

export function getManagerDecisionDestination(): ManagerDecisionDestination {
  const chatId = SecretProvider.getOptional("TELEGRAM_MANAGER_DECISION_CHAT_ID", "").trim();
  const messageThreadId = Number(SecretProvider.getOptional("TELEGRAM_MANAGER_DECISION_TOPIC_ID", ""));
  const scopeCode = SecretProvider.getOptional("TELEGRAM_MANAGER_DECISION_SCOPE", "").trim();
  if (!chatId || !Number.isSafeInteger(messageThreadId) || messageThreadId <= 0 || !scopeCode) throw new Error("MANAGER_DECISION_TOPIC_NOT_CONFIGURED");
  return { chatId, messageThreadId, scopeCode };
}

/** Persistence/orchestration boundary. It creates no work order and invokes no Decision Core transition. */
export class DecisionTelegramRequestService {
  constructor(private readonly db: any, private readonly telegram = new DecisionTelegramShadowService()) {}

  async createAndDispatch(decision: Decision, triageAuditId: string | null, actor: string) {
    if (decision.mode !== "SHADOW" || decision.sourceLinks.triageRoute !== "AI_DECISION_REQUIRED" || decision.sourceLinks.criticVerdict !== "PASS") throw new Error("DECISION_SHADOW_GATE_INVALID");
    const destination = getManagerDecisionDestination();
    const { data: group, error: groupError } = await this.db.from("telegram_pilot_groups").select("id, telegram_chat_id").eq("telegram_chat_id", Number(destination.chatId)).maybeSingle();
    if (groupError) throw groupError;
    if (!group) throw new Error("MANAGER_DECISION_GROUP_NOT_REGISTERED");
    const { data: topic, error: topicError } = await this.db.from("telegram_pilot_topics")
      .select("id")
      .eq("group_id", group.id)
      .eq("message_thread_id", destination.messageThreadId)
      .eq("is_manager_decision", true)
      .eq("status", "ACTIVE")
      .maybeSingle();
    if (topicError) throw topicError;
    if (!topic) throw new Error("MANAGER_DECISION_TOPIC_NOT_REGISTERED");
    const key = `telegram-decision:${decision.decisionId}:${destination.chatId}:${destination.messageThreadId}`;
    const { data: existing, error: existingError } = await this.db.from("telegram_decision_requests").select("*").eq("idempotency_key", key).maybeSingle();
    if (existingError) throw existingError;
    if (existing?.status === "SENT" || existing?.status === "PENDING" || existing?.status === "RESPONDED") return { request: existing, idempotent: true };
    const payload = { decision_id: decision.decisionId, triage_audit_id: triageAuditId, manager_group_id: group.id, manager_scope_code: destination.scopeCode, telegram_chat_id: Number(destination.chatId), message_thread_id: destination.messageThreadId, source_fingerprint: decision.sourceFingerprint, status: "PENDING", idempotency_key: key, metadata: { actor, mode: "SHADOW" } };
    const { data: request, error: requestError } = existing
      ? await this.db.from("telegram_decision_requests").update({ ...payload, failure_reason: null, updated_at: new Date().toISOString() }).eq("id", existing.id).select("*").single()
      : await this.db.from("telegram_decision_requests").insert(payload).select("*").single();
    if (requestError || !request) throw requestError || new Error("DECISION_REQUEST_CREATE_FAILED");
    // Rebuild the current source state immediately before delivery. Comparing a
    // decision row to itself is not a freshness check; incident, triage,
    // planner, or history changes must make the manager request stale.
    if (!isSyntheticTelegramShadowTest(decision.sourceLinks) && !(await this.hasCurrentSourceFingerprint(decision))) {
      await this.db.from("telegram_decision_requests").update({ status: "STALE", updated_at: new Date().toISOString(), failure_reason: "SOURCE_FINGERPRINT_CHANGED" }).eq("id", request.id);
      throw new Error("DECISION_REQUEST_STALE");
    }
    const action = decision.evidence.actionContext as Record<string, unknown>;
    try {
      const sent = await this.telegram.dispatch({ requestId: request.id, chatId: destination.chatId, messageThreadId: destination.messageThreadId, incident: decision.problem, finalDecision: decision.recommendedAction, why: String(action?.selectionRationale || "Deterministic final-decision ranking."), expectedOutcome: String(action?.expectedOperationalOutcome || "Operational reassessment after approval observation."), keyEvidence: Array.isArray(action?.evidenceRefs) ? action.evidenceRefs.map(String) : [], risks: Array.isArray(action?.risksAndLimitations) ? action.risksAndLimitations.map(String) : [], confidence: decision.confidence });
      const { data: completed, error: completeError } = await this.db.from("telegram_decision_requests").update({ status: "SENT", telegram_message_id: Number(sent.messageId), sent_at: new Date().toISOString(), failure_reason: null, updated_at: new Date().toISOString() }).eq("id", request.id).select("*").single();
      if (completeError) throw completeError;
      return { request: completed, idempotent: false };
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
      await this.db.from("telegram_decision_requests").update({ status: "FAILED", failure_reason: reason, updated_at: new Date().toISOString() }).eq("id", request.id);
      throw error;
    }
  }

  async hasCurrentSourceFingerprint(decision: Pick<Decision, "decisionId" | "sourceFingerprint" | "sourceLinks">): Promise<boolean> {
    const incidentId = decision.sourceLinks.incidentId;
    const plannerRunId = decision.sourceLinks.plannerRunId;
    if (!incidentId || !plannerRunId) return false;
    const [{ data: incident, error: incidentError }, { data: triage, error: triageError }, { data: planner, error: plannerError }, { data: history, error: historyError }] = await Promise.all([
      this.db.from("incidents").select("id, incident_key, updated_at, last_detected_at, status").eq("id", incidentId).maybeSingle(),
      this.db.from("incident_triage_evaluations").select("route, created_at, evidence").eq("incident_id", incidentId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      this.db.from("planner_runs").select("id, result").eq("id", plannerRunId).maybeSingle(),
      this.db.from("incident_history").select("*").eq("incident_id", incidentId).order("recorded_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (incidentError || triageError || plannerError || historyError || !incident || !triage || !planner) return false;
    return sourceFingerprint(decisionSourceSnapshot({ incident, triage, planner, history })) === decision.sourceFingerprint;
  }
}
