import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { TelegramClient } from "@/integrations/telegram";
import { formatTelegramWorkOrderReminder } from "@/integrations/telegram/work-order-reminder";
import { workOrderEvidence } from "@/integrations/telegram/work-order-evidence";
import { readJsonBody, authorizeApiRequest, resolveActor } from "@/security/api-security";
import { deriveAttentionReasons, attentionReasonLabel } from "@/domain/telegram-work-order-attention";
import { ServiceFactory } from "@/services/ServiceFactory";
import { NotificationGateway, type DeliveryRequest } from "@/notifications/gateway";
import { FEATURE_FLAGS } from "@/config/feature-flags";

type Member = { id: string; display_name: string; username: string | null };

export async function POST(request: NextRequest, { params }: { params: Promise<{ dispatchId: string }> }) {
  const { dispatchId } = await params;
  const parsed = await readJsonBody(request); if (!parsed.ok) return parsed.response;
  const authorized = await authorizeApiRequest(request, "MANAGE_DECISION", { limit: 10, windowMs: 60_000 });
  if (!authorized.ok) return authorized.response;
  try {
    const client = createAdminClient(); const actor = resolveActor(authorized.identity, parsed.body.actor) || "Manager";
    const { data: dispatch, error: dispatchError } = await client.from("telegram_work_order_dispatches").select("id, group_id, recipient_member_ids, execution_work_orders(id, work_order_code, status, owner, due_at, action_items, decision_id), telegram_pilot_groups(telegram_chat_id, title)").eq("id", dispatchId).eq("status", "SENT").maybeSingle();
    if (dispatchError) throw dispatchError;
    if (!dispatch) return NextResponse.json({ error: "TELEGRAM_DISPATCH_NOT_FOUND" }, { status: 404 });
    const workOrder = dispatch.execution_work_orders as unknown as { id: string; decision_id: string; work_order_code: string; status: "OPEN" | "IN_PROGRESS" | "COMPLETED"; owner: string; due_at: string; action_items: unknown } | null;
    const group = dispatch.telegram_pilot_groups as unknown as { telegram_chat_id: string; title: string } | null;
    if (!workOrder || !group) return NextResponse.json({ error: "TELEGRAM_REMINDER_CONTEXT_MISSING" }, { status: 409 });
    if (workOrder.status === "COMPLETED") return NextResponse.json({ error: "WORK_ORDER_ALREADY_COMPLETED" }, { status: 409 });
    const decisionResult = await ServiceFactory.getDecisionService(client).get(workOrder.decision_id);
    if (!decisionResult.ok || !decisionResult.data) return NextResponse.json({ error: "DECISION_NOT_FOUND" }, { status: 404 });
    const { data: signalRows, error: signalError } = await client.from("telegram_work_order_signals").select("signal_type").eq("dispatch_id", dispatch.id);
    if (signalError) throw signalError;
    const reasons = deriveAttentionReasons({ status: workOrder.status, dueAt: workOrder.due_at, signals: (signalRows || []).map((signal) => signal.signal_type) });
    if (!reasons.length) return NextResponse.json({ error: "WORK_ORDER_NOT_IN_ATTENTION_QUEUE", message: "Work order này không còn thuộc hàng đợi cần chú ý." }, { status: 409 });
    const memberIds = Array.isArray(dispatch.recipient_member_ids) ? dispatch.recipient_member_ids.filter((id): id is string => typeof id === "string") : [];
    const { data: members, error: memberError } = memberIds.length ? await client.from("telegram_pilot_members").select("id, display_name, username").in("id", memberIds).eq("status", "ACTIVE") : { data: [], error: null };
    if (memberError) throw memberError;
    const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
    const idempotencyKey = `telegram-reminder:${dispatch.id}:${bucket}`;
    const { data: existing, error: existingError } = await client.from("telegram_work_order_reminders").select("*").eq("idempotency_key", idempotencyKey).maybeSingle();
    if (existingError) throw existingError;
    if (existing?.status === "SENT" || existing?.status === "PENDING") return NextResponse.json({ ok: true, data: existing, idempotent: true });
    const { data: reminder, error: reminderError } = existing
      ? await client.from("telegram_work_order_reminders").update({ status: "PENDING", sent_by: actor, failure_reason: null, updated_at: new Date().toISOString() }).eq("id", existing.id).select("*").single()
      : await client.from("telegram_work_order_reminders").insert({ dispatch_id: dispatch.id, status: "PENDING", idempotency_key: idempotencyKey, sent_by: actor }).select("*").single();
    if (reminderError) throw reminderError;
    await client.from("telegram_work_order_reminder_events").insert({ reminder_id: reminder.id, event_type: "REMINDER_REQUESTED", actor, metadata: { dispatchId: dispatch.id, reasons } });
    const normalized = { workOrderId: workOrder.id, decisionId: workOrder.decision_id, workOrderCode: workOrder.work_order_code, status: workOrder.status, owner: workOrder.owner, dueAt: workOrder.due_at, actionItems: Array.isArray(workOrder.action_items) ? workOrder.action_items.filter((item): item is string => typeof item === "string") : [], createdBy: actor, createdAt: new Date().toISOString() };
    try {
      const recipients = ((members || []) as Member[]).map((member) => ({ displayName: member.display_name, username: member.username }));
      let sent: { messageId: string | number; response?: any };
      if (FEATURE_FLAGS.notificationGateway) {
        const gateway = new NotificationGateway();
        const deliveryRequest: DeliveryRequest = {
          eventType: "WORK_ORDER_REMINDER",
          message: formatTelegramWorkOrderReminder(normalized, recipients, reasons.map((reason) => attentionReasonLabel[reason]), workOrderEvidence(decisionResult.data as import("@/domain/decision").Decision, normalized)),
          audience: {
            chatId: String(group.telegram_chat_id),
            recipientMemberIds: memberIds,
          },
          options: {
            idempotencyKey: idempotencyKey,
            actor,
          },
        };
        const gatewayResult = await gateway.send(deliveryRequest, client);
        sent = { messageId: gatewayResult.primary.telegramMessageId || `gw-${Date.now()}` };
      } else {
        sent = await new TelegramClient().sendToChat(String(group.telegram_chat_id), formatTelegramWorkOrderReminder(normalized, recipients, reasons.map((reason) => attentionReasonLabel[reason]), workOrderEvidence(decisionResult.data as import("@/domain/decision").Decision, normalized)));
      }
      const { data: completed, error: completeError } = await client.from("telegram_work_order_reminders").update({ status: "SENT", telegram_message_id: Number(sent.messageId), sent_at: new Date().toISOString(), failure_reason: null, updated_at: new Date().toISOString() }).eq("id", reminder.id).select("*").single();
      if (completeError) throw completeError;
      await client.from("telegram_work_order_reminder_events").insert({ reminder_id: reminder.id, event_type: "REMINDER_SENT", actor, metadata: { telegramMessageId: sent.messageId, reasons } });
      return NextResponse.json({ ok: true, data: completed }, { status: 201 });
    } catch (sendError) {
      const reason = sendError instanceof Error ? sendError.message.slice(0, 1000) : String(sendError).slice(0, 1000);
      await client.from("telegram_work_order_reminders").update({ status: "FAILED", failure_reason: reason, updated_at: new Date().toISOString() }).eq("id", reminder.id);
      await client.from("telegram_work_order_reminder_events").insert({ reminder_id: reminder.id, event_type: "REMINDER_FAILED", actor, metadata: { reason } });
      return NextResponse.json({ error: "TELEGRAM_REMINDER_SEND_FAILED", message: reason }, { status: 502 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "TELEGRAM_REMINDER_FAILED", message }, { status: 400 });
  }
}
