import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { authorizeApiRequest } from "@/security/api-security";
import { deriveAttentionReasons } from "@/domain/telegram-work-order-attention";

type DispatchRow = { id: string; group_id: string; recipient_member_ids: unknown; sent_at: string | null; execution_work_orders: { id: string; work_order_code: string; status: string; owner: string; due_at: string; action_items: unknown } | null; telegram_pilot_groups: { title: string } | null };

export async function GET(request: NextRequest) {
  const authorized = await authorizeApiRequest(request, "MANAGE_DECISION");
  if (!authorized.ok) return authorized.response;
  try {
    const client = createAdminClient();
    const { data, error } = await client.from("telegram_work_order_dispatches").select("id, group_id, recipient_member_ids, sent_at, execution_work_orders(id, work_order_code, status, owner, due_at, action_items), telegram_pilot_groups(title)").eq("status", "SENT").order("sent_at", { ascending: false });
    if (error) throw error;
    const dispatches = (data || []) as unknown as DispatchRow[];
    const ids = dispatches.map((item) => item.id);
    const [{ data: signals, error: signalError }, { data: feedbacks, error: feedbackError }, { data: reminders, error: reminderError }] = ids.length ? await Promise.all([
      client.from("telegram_work_order_signals").select("dispatch_id, signal_type, received_at, telegram_pilot_members(display_name, username)").in("dispatch_id", ids).order("received_at", { ascending: false }),
      client.from("telegram_work_order_feedbacks").select("dispatch_id, feedback_text, received_at, telegram_pilot_members(display_name, username)").in("dispatch_id", ids).order("received_at", { ascending: false }),
      client.from("telegram_work_order_reminders").select("dispatch_id, status, sent_at, created_at").in("dispatch_id", ids).order("created_at", { ascending: false }),
    ]) : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];
    if (signalError || feedbackError || reminderError) throw signalError || feedbackError || reminderError;
    const byDispatch = <T extends { dispatch_id: string }>(rows: T[] | null) => (rows || []).reduce<Record<string, T[]>>((map, row) => { (map[row.dispatch_id] ||= []).push(row); return map; }, {});
    const signalMap = byDispatch(signals as Array<{ dispatch_id: string; signal_type: string; received_at: string; telegram_pilot_members: { display_name: string | null; username: string | null } | null }>);
    const feedbackMap = byDispatch(feedbacks as Array<{ dispatch_id: string; feedback_text: string; received_at: string; telegram_pilot_members: { display_name: string | null; username: string | null } | null }>);
    const reminderMap = byDispatch(reminders as Array<{ dispatch_id: string; status: string; sent_at: string | null; created_at: string }>);
    const items = dispatches.flatMap((dispatch) => {
      const workOrder = dispatch.execution_work_orders;
      if (!workOrder || workOrder.status === "COMPLETED") return [];
      const dispatchSignals = signalMap[dispatch.id] || [];
      const reasons = deriveAttentionReasons({ status: workOrder.status, dueAt: workOrder.due_at, signals: dispatchSignals.map((signal) => signal.signal_type) });
      if (!reasons.length) return [];
      return [{ dispatchId: dispatch.id, workOrderId: workOrder.id, workOrderCode: workOrder.work_order_code, workOrderStatus: workOrder.status, owner: workOrder.owner, dueAt: workOrder.due_at, actionItems: Array.isArray(workOrder.action_items) ? workOrder.action_items.filter((item): item is string => typeof item === "string") : [], groupTitle: dispatch.telegram_pilot_groups?.title || "Telegram group", sentAt: dispatch.sent_at, reasons, signals: dispatchSignals, latestFeedback: (feedbackMap[dispatch.id] || [])[0] || null, latestReminder: (reminderMap[dispatch.id] || [])[0] || null }];
    });
    return NextResponse.json({ ok: true, data: items });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "TELEGRAM_ATTENTION_LOAD_FAILED", message }, { status: 400 });
  }
}
