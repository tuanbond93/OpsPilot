import type { SupabaseClient } from "@supabase/supabase-js";
import { ServiceFactory } from "@/services/ServiceFactory";
import { getManagerDecisionDestination, sourceFingerprint } from "@/services/decision-telegram-shadow";
import { TelegramClient } from "@/integrations/telegram/telegram-client";
import { formatNearTermManagerCard } from "@/integrations/telegram/near-term-capacity-message";
import { buildCapacityDecisionCallbackData } from "@/integrations/telegram/capacity-decision-actions";
import type { AiRecommendation, CriticResult, CurrentRisk, DecisionContext, LeadFact } from "@/domain/near-term-capacity";

type CapacityCase = { id: string; warehouse_id: string; warehouse_name: string; current_risk_snapshot: CurrentRisk; lead_fact_snapshot: LeadFact; decision_context: DecisionContext; ai_recommendation: AiRecommendation; critic_result: CriticResult; decision_id?: string | null; decision_request_id?: string | null; source_fingerprint?: string | null };

/** Gate 2 boundary: creates an approval record and card only; no execution adapter is referenced. */
export class NearTermCapacityDecisionBridge {
  constructor(private readonly db: SupabaseClient, private readonly telegram = new TelegramClient()) {}

  async createAndDispatch(row: CapacityCase, actor: string) {
    if (row.critic_result?.verdict !== "VALID_DECISION" || row.ai_recommendation?.recommended_action === "HUMAN_INVESTIGATION_REQUIRED") return { status: "NOT_ELIGIBLE" as const };
    const fingerprint = sourceFingerprint({ caseId: row.id, facts: row.current_risk_snapshot, lead: row.lead_fact_snapshot, context: row.decision_context, recommendation: row.ai_recommendation, critic: row.critic_result });
    const decisions = ServiceFactory.getDecisionService(this.db);
    const created = await decisions.create({
      sourceLinks: { sourceType: "NEAR_TERM_CAPACITY", sourceId: row.id, capacityCaseId: row.id, criticVerdict: "PASS" } as any,
      sourceFingerprint: fingerprint, idempotencyKey: `near-term-capacity-decision:${row.id}`,
      problem: row.ai_recommendation.current_risk, rootCause: row.current_risk_snapshot.riskSignals.join(", ") || "NEAR_TERM_CAPACITY_RISK",
      recommendedAction: row.ai_recommendation.recommended_action, alternatives: row.decision_context.allowedActions.filter((action) => action !== row.ai_recommendation.recommended_action && action !== "HUMAN_INVESTIGATION_REQUIRED"),
      evidence: { sourceIdentifiers: { capacityCaseId: row.id, warehouseId: row.warehouse_id, warehouseName: row.warehouse_name }, operationalFacts: { current: row.current_risk_snapshot, lead: row.lead_fact_snapshot }, actionContext: { recommendation: row.ai_recommendation, critic: row.critic_result, evidenceRefs: row.ai_recommendation.key_evidence, allowedActions: row.decision_context.allowedActions } },
      confidence: row.ai_recommendation.confidence * 100, riskLevel: "HIGH", mode: "HUMAN_APPROVAL", decisionDeadline: row.ai_recommendation.required_by, actor,
    });
    if (!created.ok || !created.data) throw new Error(created.message || "CAPACITY_DECISION_CREATE_FAILED");
    const decision = (created.data as any).decision || created.data;
    if (decision.decisionStatus === "DRAFT") {
      const ready = await decisions.transition({ decisionId: decision.decisionId, targetStatus: "READY_FOR_REVIEW", actor, idempotencyKey: `near-term-capacity-ready:${row.id}`, metadata: { capacityCaseId: row.id } });
      if (!ready.ok) throw new Error(ready.message || "CAPACITY_DECISION_READY_FAILED");
    }
    await this.db.from("near_term_capacity_cases").update({ decision_id: decision.decisionId, source_fingerprint: fingerprint, updated_at: new Date().toISOString() }).eq("id", row.id);
    const destination = getManagerDecisionDestination();
    const { data: group, error: groupError } = await this.db.from("telegram_pilot_groups").select("id").eq("telegram_chat_id", Number(destination.chatId)).maybeSingle();
    if (groupError || !group) throw groupError || new Error("MANAGER_DECISION_GROUP_NOT_REGISTERED");
    const { data: topic, error: topicError } = await this.db.from("telegram_pilot_topics").select("id").eq("group_id", group.id).eq("message_thread_id", destination.messageThreadId).eq("is_manager_decision", true).eq("status", "ACTIVE").maybeSingle();
    if (topicError || !topic) throw topicError || new Error("MANAGER_DECISION_TOPIC_NOT_REGISTERED");
    const key = `telegram-capacity-decision:${row.id}:${destination.chatId}:${destination.messageThreadId}`;
    const { data: existing, error: existingError } = await this.db.from("telegram_decision_requests").select("*").eq("idempotency_key", key).maybeSingle();
    if (existingError) throw existingError;
    if (existing?.status === "SENT" || existing?.status === "RESPONDED") return { status: "DISPATCHED" as const, request: existing, idempotent: true };
    const payload = { decision_id: decision.decisionId, capacity_case_id: row.id, manager_group_id: group.id, manager_scope_code: destination.scopeCode, telegram_chat_id: Number(destination.chatId), message_thread_id: destination.messageThreadId, source_fingerprint: fingerprint, status: "PENDING", idempotency_key: key, metadata: { actor, sourceType: "NEAR_TERM_CAPACITY", capacityCaseId: row.id, allowedActions: row.decision_context.allowedActions } };
    const { data: request, error: requestError } = existing ? await this.db.from("telegram_decision_requests").update(payload).eq("id", existing.id).select("*").single() : await this.db.from("telegram_decision_requests").insert(payload).select("*").single();
    if (requestError || !request) throw requestError || new Error("CAPACITY_REQUEST_CREATE_FAILED");
    const card = formatNearTermManagerCard(row.warehouse_name, row.current_risk_snapshot, row.lead_fact_snapshot, row.decision_context, row.ai_recommendation);
    const sent = await this.telegram.sendToChat(destination.chatId, card, { messageThreadId: destination.messageThreadId, inlineKeyboard: [[{ text: "✅ APPROVE", callbackData: buildCapacityDecisionCallbackData(request.id, "APPROVE") }, { text: "❌ REJECT", callbackData: buildCapacityDecisionCallbackData(request.id, "REJECT") }]] });
    const { data: completed, error: completeError } = await this.db.from("telegram_decision_requests").update({ status: "SENT", telegram_message_id: Number(sent.messageId), sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", request.id).select("*").single();
    if (completeError) throw completeError;
    await this.db.from("near_term_capacity_cases").update({ decision_request_id: request.id, updated_at: new Date().toISOString() }).eq("id", row.id);
    await this.db.from("near_term_capacity_events").insert({ case_id: row.id, event_type: "MANAGER_DECISION_CARD_SENT", actor, payload: { decisionId: decision.decisionId, decisionRequestId: request.id, sourceFingerprint: fingerprint } });
    return { status: "DISPATCHED" as const, request: completed, idempotent: false };
  }
}
