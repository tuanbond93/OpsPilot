import type { SupabaseClient } from "@supabase/supabase-js";
import type { Decision } from "@/domain/decision";
import type { IDecisionService } from "@/services/interfaces/IDecisionService";
import type { ExecutionWorkOrderService } from "@/services/impl/ExecutionWorkOrderService";
import { TelegramClient } from "@/integrations/telegram/telegram-client";
import { buildDecisionCallbackData } from "@/integrations/telegram/decision-actions";
import { formatTelegramWorkOrderMessage } from "@/integrations/telegram/work-order-message";
import { workOrderEvidence } from "@/integrations/telegram/work-order-evidence";
import { workOrderInlineKeyboard } from "@/integrations/telegram/work-order-actions";

type RequestRow = { id: string; decision_id: string; telegram_chat_id: number; message_thread_id: number; metadata: Record<string, unknown> | null };
type MemberRow = { id: string; group_id: string; display_name: string; username: string | null; warehouse_name: string | null; warehouse_names: unknown };

const dueMinutes = { CRITICAL: 60, HIGH: 120, MEDIUM: 240, LOW: 480 } as const;

function decisionFromResult(result: { ok: boolean; data?: unknown }): Decision {
  const data = result.data as { decision?: Decision } | Decision | undefined;
  const decision = data && typeof data === "object" && "decision" in data ? data.decision : data as Decision | undefined;
  if (!result.ok || !decision) throw new Error("DECISION_NOT_FOUND");
  return decision;
}

function assignedWarehouses(member: MemberRow) {
  return Array.isArray(member.warehouse_names)
    ? member.warehouse_names.filter((item): item is string => typeof item === "string")
    : member.warehouse_name ? [member.warehouse_name] : [];
}

export class TelegramDecisionApprovalService {
  constructor(
    private readonly db: SupabaseClient,
    private readonly decisions: IDecisionService,
    private readonly workOrders: ExecutionWorkOrderService,
    private readonly telegram = new TelegramClient(),
  ) {}

  async prepare(request: RequestRow, shadow: Decision, actor: string) {
    if (shadow.mode !== "SHADOW" || shadow.sourceLinks.criticVerdict !== "PASS" || shadow.sourceLinks.triageRoute !== "AI_DECISION_REQUIRED") throw new Error("DECISION_GATE_INVALID");
    if (!shadow.sourceLinks.incidentId || !shadow.sourceLinks.followupCaseId || !shadow.sourceLinks.plannerRunId) throw new Error("LEVEL_C_SOURCE_LINKS_REQUIRED");
    const owner = String(shadow.evidence.sourceIdentifiers.warehouseName || "").trim();
    if (!owner) throw new Error("LEVEL_C_WAREHOUSE_REQUIRED");

    const created = await this.decisions.create({
      sourceLinks: { ...shadow.sourceLinks, sourceType: "TELEGRAM_MANAGER_APPROVED_SHADOW", sourceId: shadow.decisionId, promotedFromDecisionId: shadow.decisionId },
      sourceFingerprint: `human-approval:${shadow.decisionId}:${shadow.sourceFingerprint}`,
      idempotencyKey: `telegram-human-approval:${request.id}`,
      problem: shadow.problem, rootCause: shadow.rootCause, recommendedAction: shadow.recommendedAction,
      alternatives: shadow.alternatives, evidence: shadow.evidence, confidence: shadow.confidence,
      riskLevel: shadow.riskLevel, mode: "HUMAN_APPROVAL", decisionDeadline: shadow.decisionDeadline, actor,
    });
    let promoted = decisionFromResult(created);
    if (promoted.decisionStatus === "DRAFT") promoted = decisionFromResult(await this.decisions.transition({ decisionId: promoted.decisionId, targetStatus: "READY_FOR_REVIEW", actor, idempotencyKey: `telegram-ready:${request.id}`, metadata: { promotedFromDecisionId: shadow.decisionId } }));

    const metadata = { ...(request.metadata || {}), promotedDecisionId: promoted.decisionId, owner, preparedBy: actor, preparedAt: new Date().toISOString() };
    const [{ error }, { error: reminderLinkError }, { error: reviewLinkError }] = await Promise.all([
      this.db.from("telegram_decision_requests").update({ metadata, updated_at: new Date().toISOString() }).eq("id", request.id),
      this.db.from("telegram_followup_reminders").update({ decision_id: promoted.decisionId }).eq("followup_case_id", shadow.sourceLinks.followupCaseId).eq("decision_id", shadow.decisionId),
      this.db.from("telegram_rillnet_review_requests").update({ decision_id: promoted.decisionId }).eq("followup_case_id", shadow.sourceLinks.followupCaseId).eq("decision_id", shadow.decisionId),
    ]);
    if (error || reminderLinkError || reviewLinkError) throw error || reminderLinkError || reviewLinkError;
    await this.telegram.sendToChat(String(request.telegram_chat_id), [
      "XÁC NHẬN GIAO VIỆC LEVEL C", `Kho: ${owner}`, `Việc: ${promoted.recommendedAction}`,
      `Hạn phản hồi: ${dueMinutes[promoted.riskLevel]} phút`, "", "Bấm xác nhận để phê duyệt Decision và gửi work order cho nhân viên đã map đúng kho.",
    ].join("\n"), { messageThreadId: request.message_thread_id, inlineKeyboard: [[{ text: "✅ XÁC NHẬN GỬI", callbackData: buildDecisionCallbackData(request.id, "CONFIRM_SEND") }]] });
    return promoted;
  }

  async confirmAndDispatch(request: RequestRow, actor: string) {
    const decisionId = String(request.metadata?.promotedDecisionId || "");
    if (!decisionId) throw new Error("LEVEL_C_PREPARATION_REQUIRED");
    let decision = decisionFromResult(await this.decisions.get(decisionId));
    if (decision.decisionStatus === "READY_FOR_REVIEW") decision = decisionFromResult(await this.decisions.transition({ decisionId, targetStatus: "APPROVED", actor, idempotencyKey: `telegram-approve:${request.id}`, metadata: { channel: "TELEGRAM", confirmedRequestId: request.id } }));
    if (decision.decisionStatus !== "APPROVED") throw new Error(`DECISION_NOT_APPROVABLE:${decision.decisionStatus}`);
    const owner = String(decision.evidence.sourceIdentifiers.warehouseName || request.metadata?.owner || "").trim();
    const dueAt = new Date(Date.now() + dueMinutes[decision.riskLevel] * 60_000).toISOString();
    const workOrderResult = await this.workOrders.create({ decisionId, actor, idempotencyKey: `telegram-work-order:${request.id}`, owner, dueAt, actionItems: [decision.recommendedAction] });
    const workOrder = workOrderResult.workOrder;

    const { data: rows, error: memberError } = await this.db.from("telegram_pilot_members").select("id,group_id,display_name,username,warehouse_name,warehouse_names").eq("status", "ACTIVE");
    if (memberError) throw memberError;
    const members = ((rows || []) as MemberRow[]).filter((member) => assignedWarehouses(member).includes(owner));
    if (!members.length) throw new Error("NO_ACTIVE_EMPLOYEE_MAPPED_TO_WAREHOUSE");
    const groupIds = [...new Set(members.map((member) => member.group_id))];
    if (groupIds.length !== 1) throw new Error("AMBIGUOUS_EMPLOYEE_GROUP_MAPPING");
    const groupId = groupIds[0];
    const { data: group, error: groupError } = await this.db.from("telegram_pilot_groups").select("id,telegram_chat_id,title").eq("id", groupId).maybeSingle();
    if (groupError || !group) throw groupError || new Error("EMPLOYEE_GROUP_NOT_FOUND");
    const key = `telegram-dispatch:${workOrder.workOrderId}:${groupId}`;
    const { data: existing, error: existingError } = await this.db.from("telegram_work_order_dispatches").select("*").eq("idempotency_key", key).maybeSingle();
    if (existingError) throw existingError;
    if (existing?.status === "SENT") return { decision, workOrder, dispatch: existing, idempotent: true };
    const payload = { work_order_id: workOrder.workOrderId, group_id: groupId, status: "PENDING", recipient_member_ids: members.map((member) => member.id), idempotency_key: key, sent_by: actor };
    const { data: dispatch, error: dispatchError } = existing
      ? await this.db.from("telegram_work_order_dispatches").update({ ...payload, failure_reason: null, updated_at: new Date().toISOString() }).eq("id", existing.id).select("*").single()
      : await this.db.from("telegram_work_order_dispatches").insert(payload).select("*").single();
    if (dispatchError || !dispatch) throw dispatchError || new Error("WORK_ORDER_DISPATCH_CREATE_FAILED");
    await this.db.from("telegram_work_order_dispatch_events").insert({ dispatch_id: dispatch.id, event_type: "DISPATCH_REQUESTED", actor, metadata: { levelCDecisionId: decisionId, managerRequestId: request.id } });
    try {
      const recipients = members.map((member) => ({ displayName: member.display_name, username: member.username }));
      const sent = await this.telegram.sendToChat(String(group.telegram_chat_id), formatTelegramWorkOrderMessage(workOrder, recipients, workOrderEvidence(decision, workOrder)), { inlineKeyboard: workOrderInlineKeyboard(dispatch.id) });
      const { data: completed, error: completeError } = await this.db.from("telegram_work_order_dispatches").update({ status: "SENT", telegram_message_id: Number(sent.messageId), sent_at: new Date().toISOString(), failure_reason: null, updated_at: new Date().toISOString() }).eq("id", dispatch.id).select("*").single();
      if (completeError) throw completeError;
      await this.db.from("telegram_work_order_dispatch_events").insert({ dispatch_id: dispatch.id, event_type: "DISPATCH_SENT", actor, metadata: { telegramMessageId: sent.messageId, levelCDecisionId: decisionId, managerRequestId: request.id } });
      return { decision, workOrder, dispatch: completed, idempotent: false };
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
      await this.db.from("telegram_work_order_dispatches").update({ status: "FAILED", failure_reason: reason, updated_at: new Date().toISOString() }).eq("id", dispatch.id);
      await this.db.from("telegram_work_order_dispatch_events").insert({ dispatch_id: dispatch.id, event_type: "DISPATCH_FAILED", actor, metadata: { reason, levelCDecisionId: decisionId, managerRequestId: request.id } });
      throw error;
    }
  }
}
