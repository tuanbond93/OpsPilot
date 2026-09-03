import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { TelegramClient } from "@/integrations/telegram";
import { formatTelegramFollowupFirstPush } from "@/integrations/telegram/followup-first-push";
import { readJsonBody, resolveActor } from "@/security/api-security";
import { authorizeLinkedIncidentScope } from "@/security/scope-guard";
import warehouseAssignments from "@/data/warehouse-assignments.generated.json";
import { ServiceFactory } from "@/services/ServiceFactory";
import { NotificationGateway, type DeliveryRequest } from "@/notifications/gateway";
import { FEATURE_FLAGS, isPrivateRoutingEnabled } from "@/config/feature-flags";
import { getProvinceCode } from "@/config/pilot-provinces";
import { resolveAuthorizedRecipients, resolveProvince } from "@/notifications/gateway/scope-resolver";

type PilotMember = { id: string; group_id: string; display_name: string; username: string | null; warehouse_name: string | null; warehouse_names: unknown; zone_names: unknown };
type Group = { id: string; telegram_chat_id: string; title: string };
type WarehouseAssignment = { warehouseName: string; zone: string };
const zoneByWarehouseName = new Map((warehouseAssignments.warehouses as WarehouseAssignment[]).map((warehouse) => [warehouse.warehouseName, warehouse.zone]));

function list(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : []; }
function isEligible(member: PilotMember, warehouseName: string) {
  const warehouses = list(member.warehouse_names);
  if (member.warehouse_name) warehouses.push(member.warehouse_name);
  return warehouses.includes(warehouseName) || list(member.zone_names).includes(zoneByWarehouseName.get(warehouseName) || "");
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await readJsonBody(request); if (!parsed.ok) return parsed.response;
  const scoped = await authorizeLinkedIncidentScope(request, "followup_cases", id, "MANAGE_FOLLOWUP", { limit: 10, windowMs: 60_000 });
  if (!scoped.ok) return scoped.response;
  try {
    const client = createAdminClient();
    const actor = resolveActor(scoped.identity, parsed.body.actor) || "Manager";
    const caseResult = await ServiceFactory.getFollowupService(client).getCaseById(id);
    const followupCase = caseResult?.followupCase;
    if (!followupCase) return NextResponse.json({ error: "FOLLOWUP_CASE_NOT_FOUND" }, { status: 404 });
    if (followupCase.current_state !== "FIRST_PUSH_PENDING") return NextResponse.json({ error: "FIRST_PUSH_NOT_PENDING", message: "Chỉ gửi được khi case đang chờ nhắc lần 1." }, { status: 409 });

    const { data: incident, error: incidentError } = await client.from("incidents").select("id, incident_key, warehouse_name, reason_name, priority_score").eq("id", followupCase.incident_id).maybeSingle();
    if (incidentError) throw incidentError;
    if (!incident) return NextResponse.json({ error: "INCIDENT_NOT_FOUND" }, { status: 404 });
    const warehouseName = String(incident.warehouse_name || "Kho chưa xác định");
    const [{ data: members, error: membersError }, { data: groups, error: groupsError }, { data: histories, error: historyError }] = await Promise.all([
      client.from("telegram_pilot_members").select("id, group_id, display_name, username, warehouse_name, warehouse_names, zone_names").eq("status", "ACTIVE"),
      client.from("telegram_pilot_groups").select("id, telegram_chat_id, title").eq("status", "ACTIVE"),
      client.from("incident_history").select("sample_order_codes, maximum_age_hours").eq("incident_id", incident.id).order("recorded_at", { ascending: false }).limit(1),
    ]);
    if (membersError || groupsError || historyError) throw membersError || groupsError || historyError;
    const groupById = new Map((groups || []).map((group: Group) => [group.id, group]));
    const province = resolveProvince({ warehouse: warehouseName });
    const privateRouting = isPrivateRoutingEnabled(getProvinceCode(province));
    const scopeRecipients = privateRouting
      ? await resolveAuthorizedRecipients(client, { warehouse: warehouseName })
      : null;
    if (scopeRecipients?.quarantine) return NextResponse.json({ error: "TELEGRAM_SCOPE_QUARANTINE", message: scopeRecipients.quarantineReason || "Không thể xác định phạm vi nhận Telegram." }, { status: 409 });
    const scopedMemberIds = new Set(scopeRecipients?.employees.map((member) => member.memberId) || []);
    const recipients = ((members || []) as PilotMember[]).filter((member) =>
      groupById.has(member.group_id) && (privateRouting ? scopedMemberIds.has(member.id) : isEligible(member, warehouseName)),
    );
    const groupIds = [...new Set(recipients.map((member) => member.group_id))];
    if (!recipients.length) return NextResponse.json({ error: "TELEGRAM_RECIPIENT_NOT_MAPPED", message: "Chưa có nhân sự Telegram đang kích hoạt được map với kho hoặc vùng của case này." }, { status: 409 });
    if (groupIds.length !== 1) return NextResponse.json({ error: "TELEGRAM_ONE_GROUP_REQUIRED", message: "Case này có người nhận ở nhiều group. Hãy để một group pilot trước khi gửi thử." }, { status: 409 });
    const group = groupById.get(groupIds[0]);
    if (!group) return NextResponse.json({ error: "TELEGRAM_GROUP_NOT_FOUND" }, { status: 404 });

    // Use the same canonical key as the scheduled pilot dispatcher. A manual
    // retry must never create a second Telegram message for the same case/stage.
    const idempotencyKey = `telegram-followup:${followupCase.id}:FIRST`;
    const { data: existing, error: existingError } = await client.from("telegram_followup_reminders").select("*").eq("idempotency_key", idempotencyKey).maybeSingle();
    if (existingError) throw existingError;
    if (existing?.status === "SENT" || existing?.status === "PENDING") return NextResponse.json({ ok: true, data: existing, idempotent: true });
    const reminderRow = { followup_case_id: followupCase.id, group_id: group.id, reminder_stage: "FIRST", status: "PENDING", recipient_member_ids: recipients.map((member) => member.id), idempotency_key: idempotencyKey, sent_by: actor };
    const { data: reminder, error: reminderError } = existing
      ? await client.from("telegram_followup_reminders").update({ status: "PENDING", failure_reason: null, sent_by: actor, updated_at: new Date().toISOString() }).eq("id", existing.id).select("*").single()
      : await client.from("telegram_followup_reminders").insert(reminderRow).select("*").single();
    if (reminderError) {
      // Another cron/manual request may have claimed the unique key between
      // the read above and this insert. Treat that race as an idempotent hit.
      if ((reminderError as { code?: string }).code === "23505") {
        const { data: raced } = await client.from("telegram_followup_reminders").select("*").eq("idempotency_key", idempotencyKey).maybeSingle();
        if (raced?.status === "SENT" || raced?.status === "PENDING") return NextResponse.json({ ok: true, data: raced, idempotent: true });
      }
      throw reminderError;
    }
    await client.from("telegram_followup_reminder_events").insert({ reminder_id: reminder.id, event_type: "REMINDER_REQUESTED", actor, metadata: { followupCaseId: followupCase.id, incidentId: incident.id, recipientMemberIds: recipients.map((member) => member.id) } });

    const history = histories?.[0] as { sample_order_codes?: unknown; maximum_age_hours?: number | null } | undefined;
    try {
      let sent: { messageId: string | number; response?: any };
      if (FEATURE_FLAGS.notificationGateway) {
        const gateway = new NotificationGateway();
        const deliveryRequest: DeliveryRequest = {
          eventType: "FIRST_PUSH",
          incidentId: incident.id,
          incidentKey: String(incident.incident_key || followupCase.incident_key),
          followupCaseId: followupCase.id,
          message: formatTelegramFollowupFirstPush({ incidentKey: String(incident.incident_key || followupCase.incident_key), warehouseName, reasonName: String(incident.reason_name || "Sự cố vận hành"), affectedOrderCount: Number(followupCase.latest_affected_order_count || 0), maximumAgeHours: history?.maximum_age_hours, orderCodes: list(history?.sample_order_codes) }, recipients.map((member) => ({ displayName: member.display_name, username: member.username }))),
          audience: {
            warehouse: warehouseName,
            chatId: String(group.telegram_chat_id),
            recipientMemberIds: recipients.map(m => m.id),
          },
          options: {
            parseMode: "HTML",
            idempotencyKey: idempotencyKey,
            actor,
          },
        };
        const gatewayResult = await gateway.send(deliveryRequest, client);
        sent = { messageId: gatewayResult.primary.telegramMessageId || `gw-${Date.now()}` };
      } else {
        sent = await new TelegramClient().sendToChat(String(group.telegram_chat_id), formatTelegramFollowupFirstPush({ incidentKey: String(incident.incident_key || followupCase.incident_key), warehouseName, reasonName: String(incident.reason_name || "Sự cố vận hành"), affectedOrderCount: Number(followupCase.latest_affected_order_count || 0), maximumAgeHours: history?.maximum_age_hours, orderCodes: list(history?.sample_order_codes) }, recipients.map((member) => ({ displayName: member.display_name, username: member.username }))), { parseMode: "HTML" });
      }
      const now = new Date().toISOString();
      const { data: sentReminder, error: sentError } = await client.from("telegram_followup_reminders").update({ status: "SENT", telegram_message_id: Number(sent.messageId), sent_at: now, failure_reason: null, updated_at: now }).eq("id", reminder.id).select("*").single();
      if (sentError) throw sentError;
      await client.from("telegram_followup_reminder_events").insert({ reminder_id: reminder.id, event_type: "REMINDER_SENT", actor, metadata: { telegramMessageId: sent.messageId } });
      const confirmation = await ServiceFactory.getFollowupService(client).confirmFollowupAction(followupCase.id, "first_push", `telegram_manual:${actor}`);
      if (!confirmation.ok) throw new Error(confirmation.message || "Follow-up state could not be confirmed after Telegram delivery.");
      await client.from("notification_actions").update({ status: "CANCELLED", processed_at: now, outcome: "DELIVERED", provider: "telegram", provider_message_id: String(sent.messageId), provider_response: { mode: "manual_followup_first_push", reminderId: reminder.id } }).eq("action_type", "FIRST_PUSH").eq("status", "PENDING").contains("payload", { incidentId: followupCase.incident_id });
      return NextResponse.json({ ok: true, data: sentReminder, followupCase: confirmation.followupCase }, { status: 201 });
    } catch (sendError) {
      const reason = sendError instanceof Error ? sendError.message.slice(0, 1000) : String(sendError).slice(0, 1000);
      await client.from("telegram_followup_reminders").update({ status: "FAILED", failure_reason: reason, updated_at: new Date().toISOString() }).eq("id", reminder.id);
      await client.from("telegram_followup_reminder_events").insert({ reminder_id: reminder.id, event_type: "REMINDER_FAILED", actor, metadata: { reason } });
      return NextResponse.json({ error: "TELEGRAM_FOLLOWUP_REMINDER_SEND_FAILED", message: reason }, { status: 502 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "TELEGRAM_FOLLOWUP_REMINDER_FAILED", message }, { status: 400 });
  }
}
