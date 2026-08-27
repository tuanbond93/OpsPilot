import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { TelegramClient } from "@/integrations/telegram";
import { formatTelegramWorkOrderMessage } from "@/integrations/telegram/work-order-message";
import { workOrderInlineKeyboard } from "@/integrations/telegram/work-order-actions";
import { ServiceFactory } from "@/services/ServiceFactory";
import { readJsonBody, resolveActor } from "@/security/api-security";
import { authorizeDecisionScope } from "@/security/scope-guard";

type PilotMember = { id: string; group_id: string; display_name: string; username: string | null; warehouse_name: string | null; warehouse_names: unknown; pilot_role: string; status: string };
type PilotGroup = { id: string; telegram_chat_id: string; title: string };

function warehouseNames(member: PilotMember) {
  return Array.isArray(member.warehouse_names)
    ? member.warehouse_names.filter((value): value is string => typeof value === "string")
    : member.warehouse_name ? [member.warehouse_name] : [];
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: "TELEGRAM_DISPATCH_FAILED", message }, { status: 400 });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ decisionId: string }> }) {
  const { decisionId } = await params;
  const scoped = await authorizeDecisionScope(request, decisionId, "VIEW_SYSTEM");
  if (!scoped.ok) return scoped.response;
  try {
    const client = createAdminClient();
    const workOrder = await ServiceFactory.getExecutionWorkOrderService(client).get(decisionId);
    if (!workOrder) return NextResponse.json({ ok: true, data: { workOrder: null, candidates: [], dispatch: null } });
    const [{ data: members, error: memberError }, { data: groups, error: groupError }, { data: dispatch, error: dispatchError }] = await Promise.all([
      client.from("telegram_pilot_members").select("*").eq("status", "ACTIVE"),
      client.from("telegram_pilot_groups").select("id, telegram_chat_id, title"),
      client.from("telegram_work_order_dispatches").select("*").eq("work_order_id", workOrder.workOrderId).order("created_at", { ascending: false }).maybeSingle(),
    ]);
    if (memberError || groupError || dispatchError) throw memberError || groupError || dispatchError;
    const { data: feedbacks, error: feedbackError } = dispatch
      ? await client.from("telegram_work_order_feedbacks").select("id, member_id, feedback_text, received_at, telegram_message_id, telegram_pilot_members(display_name, username)").eq("dispatch_id", dispatch.id).order("received_at", { ascending: true })
      : { data: [], error: null };
    if (feedbackError) throw feedbackError;
    const { data: signals, error: signalError } = dispatch
      ? await client.from("telegram_work_order_signals").select("id, signal_type, received_at, telegram_pilot_members(display_name, username)").eq("dispatch_id", dispatch.id).order("received_at", { ascending: true })
      : { data: [], error: null };
    if (signalError) throw signalError;
    const groupById = new Map((groups || []).map((group: PilotGroup) => [group.id, group]));
    const candidates = (members || []).filter((member: PilotMember) => warehouseNames(member).includes(workOrder.owner) && groupById.has(member.group_id)).map((member: PilotMember) => ({ memberId: member.id, groupId: member.group_id, groupTitle: groupById.get(member.group_id)?.title || "Telegram group", displayName: member.display_name, username: member.username, pilotRole: member.pilot_role }));
    return NextResponse.json({ ok: true, data: { workOrder, candidates, dispatch: dispatch ? { ...dispatch, feedbacks: feedbacks || [], signals: signals || [] } : null } });
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ decisionId: string }> }) {
  const { decisionId } = await params; const parsed = await readJsonBody(request); if (!parsed.ok) return parsed.response;
  const scoped = await authorizeDecisionScope(request, decisionId, "MANAGE_DECISION", { limit: 10, windowMs: 60_000 }); if (!scoped.ok) return scoped.response;
  try {
    const memberIds = Array.isArray(parsed.body.recipientMemberIds) ? Array.from(new Set(parsed.body.recipientMemberIds.filter((value): value is string => typeof value === "string" && value.length > 0))).slice(0, 30) : [];
    if (!memberIds.length) return NextResponse.json({ error: "TELEGRAM_RECIPIENT_REQUIRED", message: "Chọn ít nhất một nhân viên Telegram đã kích hoạt." }, { status: 400 });
    const actor = resolveActor(scoped.identity, parsed.body.actor);
    const client = createAdminClient();
    const workOrder = await ServiceFactory.getExecutionWorkOrderService(client).get(decisionId);
    if (!workOrder) return NextResponse.json({ error: "WORK_ORDER_NOT_FOUND" }, { status: 404 });
    if (workOrder.status === "COMPLETED") return NextResponse.json({ error: "WORK_ORDER_ALREADY_COMPLETED" }, { status: 409 });
    const { data: selected, error: selectedError } = await client.from("telegram_pilot_members").select("*").in("id", memberIds).eq("status", "ACTIVE");
    if (selectedError) throw selectedError;
    const members = (selected || []) as PilotMember[];
    if (members.length !== memberIds.length || members.some((member) => !warehouseNames(member).includes(workOrder.owner))) return NextResponse.json({ error: "TELEGRAM_RECIPIENT_NOT_ELIGIBLE", message: "Người nhận phải đang kích hoạt và được map với đúng kho owner của work order." }, { status: 400 });
    const groupId = members[0].group_id;
    if (members.some((member) => member.group_id !== groupId)) return NextResponse.json({ error: "TELEGRAM_ONE_GROUP_REQUIRED", message: "TG-02 chỉ gửi một work order vào một group; hãy chọn nhân sự trong cùng group." }, { status: 400 });
    const { data: group, error: groupError } = await client.from("telegram_pilot_groups").select("id, telegram_chat_id, title").eq("id", groupId).maybeSingle();
    if (groupError) throw groupError;
    if (!group) return NextResponse.json({ error: "TELEGRAM_GROUP_NOT_FOUND" }, { status: 404 });
    const { data: existing, error: existingError } = await client.from("telegram_work_order_dispatches").select("*").eq("work_order_id", workOrder.workOrderId).eq("group_id", groupId).maybeSingle();
    if (existingError) throw existingError;
    if (existing?.status === "SENT" || existing?.status === "PENDING") return NextResponse.json({ ok: true, data: existing, idempotent: true });
    const idempotencyKey = `telegram-dispatch:${workOrder.workOrderId}:${groupId}`;
    const row = { work_order_id: workOrder.workOrderId, group_id: groupId, status: "PENDING", recipient_member_ids: memberIds, idempotency_key: idempotencyKey, sent_by: actor };
    const { data: dispatch, error: insertError } = existing
      ? await client.from("telegram_work_order_dispatches").update({ status: "PENDING", recipient_member_ids: memberIds, sent_by: actor, failure_reason: null, updated_at: new Date().toISOString() }).eq("id", existing.id).select("*").single()
      : await client.from("telegram_work_order_dispatches").insert(row).select("*").single();
    if (insertError) throw insertError;
    await client.from("telegram_work_order_dispatch_events").insert({ dispatch_id: dispatch.id, event_type: "DISPATCH_REQUESTED", actor, metadata: { groupId, recipientMemberIds: memberIds, workOrderCode: workOrder.workOrderCode } });
    try {
      const sent = await new TelegramClient().sendToChat(String(group.telegram_chat_id), formatTelegramWorkOrderMessage(workOrder, members.map((member) => ({ displayName: member.display_name, username: member.username }))), { inlineKeyboard: workOrderInlineKeyboard(dispatch.id) });
      const { data: completed, error: completeError } = await client.from("telegram_work_order_dispatches").update({ status: "SENT", telegram_message_id: Number(sent.messageId), sent_at: new Date().toISOString(), failure_reason: null, updated_at: new Date().toISOString() }).eq("id", dispatch.id).select("*").single();
      if (completeError) throw completeError;
      await client.from("telegram_work_order_dispatch_events").insert({ dispatch_id: dispatch.id, event_type: "DISPATCH_SENT", actor, metadata: { telegramMessageId: sent.messageId } });
      return NextResponse.json({ ok: true, data: completed }, { status: existing ? 200 : 201 });
    } catch (sendError) {
      const reason = sendError instanceof Error ? sendError.message.slice(0, 1000) : String(sendError).slice(0, 1000);
      await client.from("telegram_work_order_dispatches").update({ status: "FAILED", failure_reason: reason, updated_at: new Date().toISOString() }).eq("id", dispatch.id);
      await client.from("telegram_work_order_dispatch_events").insert({ dispatch_id: dispatch.id, event_type: "DISPATCH_FAILED", actor, metadata: { reason } });
      return NextResponse.json({ error: "TELEGRAM_SEND_FAILED", message: reason }, { status: 502 });
    }
  } catch (error) { return failure(error); }
}
