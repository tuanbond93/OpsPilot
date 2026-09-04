import type { SupabaseClient } from "@supabase/supabase-js";
import warehouseAssignments from "@/data/warehouse-assignments.generated.json";
import type { IncidentReasonCode } from "@/engine/incident";
import { TelegramClient } from "@/integrations/telegram";
import { formatTelegramFollowupReminder, type FollowupReminderStage } from "@/integrations/telegram/followup-first-push";
import { followupInlineKeyboard, supportsStructuredOutboundResponses } from "@/integrations/telegram/followup-actions";
import { ServiceFactory } from "@/services/ServiceFactory";
import { NotificationGateway, type DeliveryRequest } from "@/notifications/gateway";
import { FEATURE_FLAGS } from "@/config/feature-flags";
import { dispatchRillnetChangeReviews } from "@/services/telegram-rillnet-review";
import { formatFollowupDeliverySummary, type FollowupDeliverySummaryItem } from "@/integrations/telegram/followup-delivery-summary";

type PilotMember = { id: string; group_id: string; display_name: string; username: string | null; warehouse_name: string | null; warehouse_names: unknown; zone_names: unknown };
type PilotGroup = { id: string; telegram_chat_id: string; title: string };
type WarehouseAssignment = { warehouseName: string; zone: string; province: string };
type PilotTopic = { id: string; group_id: string; message_thread_id: number; topic_title: string; province_name: string | null; is_escalation: boolean; status: string };
type PendingCase = { id: string; incident_id: string; incident_key: string; current_state: string; first_detected_at: string; latest_affected_order_count: number; last_action_requested_at: string | null };
type ActionRequestEvent = { followup_case_id: string; event_type: string; event_time: string };
type Incident = { id: string; incident_key: string; warehouse_id: string; warehouse_name: string | null; reason_code: string; reason_name: string; priority_score: number; first_detected_at: string; last_detected_at: string };
type History = { sample_order_codes?: unknown; maximum_age_hours?: number | null };
type Candidate = { followupCase: PendingCase; incident: Incident; stage: FollowupReminderStage; action: "first_push" | "second_push" | "third_push" | "escalation"; attemptMarker: string; group: PilotGroup; topic: PilotTopic; recipients: PilotMember[]; history?: History };

const PILOT_ZONE = "Miền Bắc 3";
// Keep a comfortable per-group cadence. This is effectively three messages
// per five seconds, while avoiding a burst of three messages at the same
// instant that can trigger Telegram group flood protection.
const TELEGRAM_MESSAGE_INTERVAL_MS = 1_700;
const zoneByWarehouseName = new Map((warehouseAssignments.warehouses as WarehouseAssignment[]).map((warehouse) => [warehouse.warehouseName, warehouse.zone]));
const zoneByWarehouseId = new Map((warehouseAssignments.warehouses as Array<WarehouseAssignment & { warehouseId: string }>).map((warehouse) => [String(warehouse.warehouseId), warehouse.zone]));
const provinceByWarehouseName = new Map((warehouseAssignments.warehouses as WarehouseAssignment[]).map((warehouse) => [warehouse.warehouseName, warehouse.province]));
const provinceByWarehouseId = new Map((warehouseAssignments.warehouses as Array<WarehouseAssignment & { warehouseId: string }>).map((warehouse) => [String(warehouse.warehouseId), warehouse.province]));
const stageByState: Record<string, { stage: FollowupReminderStage; action: "first_push" | "second_push" | "third_push" | "escalation" }> = {
  FIRST_PUSH_PENDING: { stage: "FIRST", action: "first_push" },
  SECOND_PUSH_PENDING: { stage: "SECOND", action: "second_push" },
  THIRD_PUSH_PENDING: { stage: "THIRD", action: "third_push" },
  ESCALATION_PENDING: { stage: "ESCALATION", action: "escalation" },
};

function list(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : []; }
function provinceKey(value: string | null | undefined) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").trim().toLocaleLowerCase("vi");
}
function isEligible(member: PilotMember, warehouseName: string, zoneName: string | null) {
  const warehouses = [...list(member.warehouse_names), ...(member.warehouse_name ? [member.warehouse_name] : [])];
  return warehouses.includes(warehouseName) || Boolean(zoneName && list(member.zone_names).includes(zoneName));
}

export type TelegramFollowupPilotResult = { scanned: number; sent: number; coveredCases: number; skipped: number; deferred: number; failed: number; stateConfirmationsFailed: number; rillnetReviews: { scanned: number; sent: number; skipped: number; failed: number }; details: Array<{ followupCaseId: string; status: string; reason?: string }> };

/**
 * Sends only deterministic, roster-mapped Miền Bắc 3 follow-up messages.
 * It never runs an operational action and is idempotent per case + ladder stage.
 */
export async function runTelegramFollowupPilotDispatch(client: SupabaseClient, actor = "telegram_followup_pilot"): Promise<TelegramFollowupPilotResult> {
  const result: TelegramFollowupPilotResult = { scanned: 0, sent: 0, coveredCases: 0, skipped: 0, deferred: 0, failed: 0, stateConfirmationsFailed: 0, rillnetReviews: { scanned: 0, sent: 0, skipped: 0, failed: 0 }, details: [] };
  const reviewResult = await dispatchRillnetChangeReviews(client, actor);
  result.rillnetReviews = { scanned: reviewResult.scanned, sent: reviewResult.sent, skipped: reviewResult.skipped, failed: reviewResult.failed };
  result.failed += reviewResult.failed;
  result.details.push(...reviewResult.details.map((item) => ({ ...item, status: `RILLNET_REVIEW_${item.status}` })));
  // The queue is global while this pilot is deliberately scoped to Miền Bắc 3.
  // Read a bounded wider window so non-pilot cases cannot starve eligible pilot
  // cases simply because they happen to be older in the global ordering.
  const { data: pendingRows, error: pendingError } = await client.from("followup_cases").select("id, incident_id, incident_key, current_state, first_detected_at, latest_affected_order_count, last_action_requested_at").in("current_state", Object.keys(stageByState)).order("last_action_requested_at", { ascending: true }).limit(1000);
  if (pendingError) throw pendingError;
  const cases = (pendingRows || []) as PendingCase[];
  if (!cases.length) return result;

  const [{ data: incidents, error: incidentError }, { data: members, error: memberError }, { data: groups, error: groupError }, { data: topics, error: topicError }] = await Promise.all([
    client.from("incidents").select("id, incident_key, warehouse_id, warehouse_name, reason_code, reason_name, priority_score, first_detected_at, last_detected_at").in("incident_key", cases.map((item) => item.incident_key)),
    client.from("telegram_pilot_members").select("id, group_id, display_name, username, warehouse_name, warehouse_names, zone_names").eq("status", "ACTIVE"),
    client.from("telegram_pilot_groups").select("id, telegram_chat_id, title").eq("status", "ACTIVE"),
    client.from("telegram_pilot_topics").select("id, group_id, message_thread_id, topic_title, province_name, is_escalation, status").eq("status", "ACTIVE"),
  ]);
  if (incidentError || memberError || groupError || topicError) throw incidentError || memberError || groupError || topicError;
  const incidentByKey = new Map((incidents || []).map((incident) => [incident.incident_key, incident as Incident]));
  const groupsById = new Map((groups || []).map((group) => [group.id, group as PilotGroup]));
  const topicsByGroup = new Map<string, PilotTopic[]>();
  for (const topic of (topics || []) as PilotTopic[]) topicsByGroup.set(topic.group_id, [...(topicsByGroup.get(topic.group_id) || []), topic]);
  const pilotCases = cases.filter((followupCase) => {
    const incident = incidentByKey.get(followupCase.incident_key);
    if (!incident) return false;
    const zoneName = zoneByWarehouseId.get(String(incident.warehouse_id)) || zoneByWarehouseName.get(String(incident.warehouse_name || "")) || null;
    return zoneName === PILOT_ZONE;
  });
  result.scanned = pilotCases.length;

  const { data: actionRequestEvents, error: actionRequestError } = await client.from("followup_events")
    .select("followup_case_id, event_type, event_time")
    .in("followup_case_id", pilotCases.map((item) => item.id))
    .in("event_type", ["CASE_CREATED", "CASE_REOPENED", "PUSH_REQUESTED", "ESCALATION_REQUESTED"])
    .order("event_time", { ascending: false })
    .limit(1000);
  if (actionRequestError) throw actionRequestError;
  const latestActionRequestByCase = new Map<string, string>();
  for (const event of (actionRequestEvents || []) as ActionRequestEvent[]) {
    if (!latestActionRequestByCase.has(event.followup_case_id)) latestActionRequestByCase.set(event.followup_case_id, event.event_time);
  }

  const candidates: Candidate[] = [];
  const deliverySummary: FollowupDeliverySummaryItem[] = [];
  let lastTelegramMessageAt = 0;
  for (const followupCase of pilotCases) {
    const stageInfo = stageByState[followupCase.current_state];
    const incident = incidentByKey.get(followupCase.incident_key);
    if (!stageInfo || !incident) { result.skipped++; result.details.push({ followupCaseId: followupCase.id, status: "SKIPPED", reason: "incident_or_stage_missing" }); continue; }
    const warehouseName = String(incident.warehouse_name || "");
    const zoneName = zoneByWarehouseId.get(String(incident.warehouse_id)) || zoneByWarehouseName.get(warehouseName) || null;
    const route = "AUTO_HANDLE";
    if (zoneName !== PILOT_ZONE || route !== "AUTO_HANDLE") { result.skipped++; result.details.push({ followupCaseId: followupCase.id, status: "SKIPPED", reason: `not_eligible:${zoneName || "unknown"}:${route}` }); continue; }
    const scopeMatches = ((members || []) as PilotMember[]).filter((member) => isEligible(member, warehouseName, zoneName));
    const recipients = scopeMatches.filter((member) => groupsById.has(member.group_id));
    const groupIds = [...new Set(recipients.map((member) => member.group_id))];
    const group = groupIds.length === 1 ? groupsById.get(groupIds[0]) : null;
    if (!group) { result.skipped++; result.details.push({ followupCaseId: followupCase.id, status: "SKIPPED", reason: !scopeMatches.length ? `roster_missing:active_members=${(members || []).length}:scope_matches=0` : !recipients.length ? `group_missing:scope_matches=${scopeMatches.length}` : `multiple_groups:recipients=${recipients.length}:groups=${groupIds.length}` }); continue; }
    const provinceName = provinceByWarehouseId.get(String(incident.warehouse_id)) || provinceByWarehouseName.get(warehouseName) || null;
    const groupTopics = topicsByGroup.get(group.id) || [];
    const topic = groupTopics.find((item) => provinceKey(item.province_name) === provinceKey(provinceName)) || groupTopics.find((item) => item.is_escalation);
    if (!topic) { result.skipped++; result.details.push({ followupCaseId: followupCase.id, status: "SKIPPED", reason: `topic_missing:province=${provinceName || "unknown"}` }); continue; }
    const attemptMarker = followupCase.last_action_requested_at || latestActionRequestByCase.get(followupCase.id) || followupCase.first_detected_at;
    const idempotencyKey = `telegram-followup:${followupCase.id}:${stageInfo.stage}:${attemptMarker}`;
    const { data: existing, error: existingError } = await client.from("telegram_followup_reminders").select("status").eq("idempotency_key", idempotencyKey).maybeSingle();
    if (existingError) throw existingError;
    if (existing?.status === "SENT" || existing?.status === "PENDING") { result.skipped++; result.details.push({ followupCaseId: followupCase.id, status: "SKIPPED", reason: "already_dispatched" }); continue; }
    const { data: histories, error: historyError } = await client.from("incident_history").select("sample_order_codes, maximum_age_hours").eq("incident_id", incident.id).order("recorded_at", { ascending: false }).limit(1);
    if (historyError) throw historyError;
    candidates.push({ followupCase, incident, stage: stageInfo.stage, action: stageInfo.action, attemptMarker, group, topic, recipients, history: histories?.[0] as History | undefined });
  }

  const batches = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = [candidate.group.id, candidate.topic.message_thread_id, candidate.stage, candidate.incident.warehouse_id, candidate.incident.reason_code].join(":");
    (batches.get(key) || (batches.set(key, []), batches.get(key)!)).push(candidate);
  }

  for (const batch of batches.values()) {
    const first = batch[0];
    const now = new Date().toISOString();
    const reminders: Array<{ id: string; candidate: Candidate }> = [];
    for (const candidate of batch) {
      const idempotencyKey = `telegram-followup:${candidate.followupCase.id}:${candidate.stage}:${candidate.attemptMarker}`;
      const payload = { followup_case_id: candidate.followupCase.id, group_id: first.group.id, message_thread_id: first.topic.message_thread_id, reminder_stage: candidate.stage, status: "PENDING", recipient_member_ids: candidate.recipients.map((member) => member.id), idempotency_key: idempotencyKey, sent_by: actor };
      const { data: reminder, error: reminderError } = await client.from("telegram_followup_reminders").insert(payload).select("id").single();
      if (reminderError) {
        // Concurrent cron/manual dispatches can race after the preflight read.
        // The unique idempotency key is the authority; a conflict means the
        // other request already owns this case/stage, not a delivery failure.
        if ((reminderError as { code?: string }).code === "23505") {
          result.skipped++;
          result.details.push({ followupCaseId: candidate.followupCase.id, status: "SKIPPED", reason: "already_dispatched_race" });
        } else {
          result.failed++;
          result.details.push({ followupCaseId: candidate.followupCase.id, status: "FAILED", reason: reminderError.message });
        }
        continue;
      }
      reminders.push({ id: reminder.id, candidate });
      await client.from("telegram_followup_reminder_events").insert({ reminder_id: reminder.id, event_type: "REMINDER_REQUESTED", actor, metadata: { stage: candidate.stage, followupCaseId: candidate.followupCase.id, incidentId: candidate.incident.id, recipientMemberIds: candidate.recipients.map((member) => member.id), pilotZone: PILOT_ZONE, aggregateSize: batch.length } });
    }
    if (!reminders.length) continue;
    const orderCodes = [...new Set(batch.flatMap((candidate) => list(candidate.history?.sample_order_codes)))];
    const structuredOutboundResponses = supportsStructuredOutboundResponses(first.incident.reason_code);
    const message = formatTelegramFollowupReminder(first.stage, { incidentKey: first.incident.incident_key || first.followupCase.incident_key, warehouseName: String(first.incident.warehouse_name || ""), reasonName: first.incident.reason_name, affectedOrderCount: batch.reduce((total, candidate) => total + Number(candidate.followupCase.latest_affected_order_count || 0), 0), maximumAgeHours: Math.max(...batch.map((candidate) => Number(candidate.history?.maximum_age_hours || 0))), orderCodes, structuredOutboundResponses }, first.recipients.map((member) => ({ displayName: member.display_name, username: member.username })));
    const inlineKeyboard = structuredOutboundResponses ? followupInlineKeyboard(reminders[0].id, true) : undefined;
    try {
      const waitMs = Math.max(0, TELEGRAM_MESSAGE_INTERVAL_MS - (Date.now() - lastTelegramMessageAt));
      if (waitMs) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      
      let sent: { messageId: string | number; response?: any };
      if (FEATURE_FLAGS.notificationGateway) {
        const gateway = new NotificationGateway();
        const provinceName = provinceByWarehouseId.get(String(first.incident.warehouse_id)) || provinceByWarehouseName.get(String(first.incident.warehouse_name || "")) || null;
        const deliveryRequest: DeliveryRequest = {
          eventType: first.stage === "ESCALATION" ? "ESCALATION" : 
                     first.action === "first_push" ? "FIRST_PUSH" :
                     first.action === "second_push" ? "SECOND_PUSH" : "THIRD_PUSH",
          incidentId: first.incident.id,
          incidentKey: first.incident.incident_key || first.followupCase.incident_key,
          followupCaseId: first.followupCase.id,
          message,
          audience: {
            province: provinceName || undefined,
            warehouse: String(first.incident.warehouse_name || ""),
            warehouseId: String(first.incident.warehouse_id),
            chatId: String(first.group.telegram_chat_id),
            messageThreadId: first.topic.message_thread_id,
            recipientMemberIds: first.recipients.map(m => m.id),
          },
          options: {
            parseMode: "HTML",
            inlineKeyboard,
            idempotencyKey: `telegram-followup:${first.followupCase.id}:${first.stage}:${first.attemptMarker}`,
            actor,
            mirror: false,
          },
        };
        const gatewayResult = await gateway.send(deliveryRequest, client);
        sent = { messageId: gatewayResult.primary.telegramMessageId || `gw-${Date.now()}` };
      } else {
        sent = await new TelegramClient().sendToChat(String(first.group.telegram_chat_id), message, { parseMode: "HTML", messageThreadId: first.topic.message_thread_id, inlineKeyboard });
      }
      lastTelegramMessageAt = Date.now();
      const deliveredAt = new Date().toISOString();
      const reminderIds = reminders.map((item) => item.id);
      const { error: deliveredError } = await client.from("telegram_followup_reminders").update({ status: "SENT", telegram_message_id: Number(sent.messageId), sent_at: deliveredAt, failure_reason: null, updated_at: deliveredAt }).in("id", reminderIds);
      if (deliveredError) throw deliveredError;
      await client.from("telegram_followup_reminder_events").insert(reminders.map((item) => ({ reminder_id: item.id, event_type: "REMINDER_SENT", actor, metadata: { stage: first.stage, telegramMessageId: sent.messageId, messageThreadId: first.topic.message_thread_id, topicTitle: first.topic.topic_title, aggregateSize: reminders.length } })));
      for (const { id: reminderId, candidate } of reminders) {
        const confirmation = await ServiceFactory.getFollowupService(client).confirmFollowupAction(candidate.followupCase.id, candidate.action, actor);
        if (!confirmation.ok) { result.stateConfirmationsFailed++; result.details.push({ followupCaseId: candidate.followupCase.id, status: "SENT_STATE_CONFIRMATION_FAILED", reason: confirmation.message }); continue; }
        await client.from("notification_actions").update({ status: "CANCELLED", processed_at: deliveredAt, outcome: "DELIVERED", provider: "telegram", provider_message_id: String(sent.messageId), provider_response: { mode: "telegram_followup_aggregate", reminderId, stage: candidate.stage, aggregateSize: reminders.length } }).eq("action_type", candidate.action === "first_push" ? "FIRST_PUSH" : candidate.action === "second_push" ? "SECOND_PUSH" : candidate.action === "third_push" ? "THIRD_PUSH" : "ESCALATION").eq("status", "PENDING").contains("payload", { incidentId: candidate.followupCase.incident_id });
        result.details.push({ followupCaseId: candidate.followupCase.id, status: "SENT" });
      }
      result.sent++;
      result.coveredCases += reminders.length;
      deliverySummary.push({ province: provinceByWarehouseId.get(String(first.incident.warehouse_id)) || provinceByWarehouseName.get(String(first.incident.warehouse_name || "")) || "Chưa xác định", warehouse: String(first.incident.warehouse_name || ""), stage: first.stage, coveredCases: reminders.length, status: "SUCCESS" });
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
      const reminderIds = reminders.map((item) => item.id);
      await client.from("telegram_followup_reminders").update({ status: "FAILED", failure_reason: reason, updated_at: new Date().toISOString() }).in("id", reminderIds);
      await client.from("telegram_followup_reminder_events").insert(reminders.map((item) => ({ reminder_id: item.id, event_type: "REMINDER_FAILED", actor, metadata: { stage: first.stage, reason, aggregateSize: reminders.length } })));
      result.failed += reminders.length;
      deliverySummary.push({ province: provinceByWarehouseId.get(String(first.incident.warehouse_id)) || provinceByWarehouseName.get(String(first.incident.warehouse_name || "")) || "Chưa xác định", warehouse: String(first.incident.warehouse_name || ""), stage: first.stage, coveredCases: reminders.length, status: "FAILED", error: reason });
      reminders.forEach(({ candidate }) => result.details.push({ followupCaseId: candidate.followupCase.id, status: "FAILED", reason }));
    }
  }
  if (deliverySummary.length || reviewResult.summaries.length) {
    const { data: managerTopic, error: managerTopicError } = await client.from("telegram_pilot_topics")
      .select("message_thread_id, telegram_pilot_groups!inner(telegram_chat_id, status)")
      .eq("status", "ACTIVE").eq("is_manager_decision", true).eq("telegram_pilot_groups.status", "ACTIVE").maybeSingle();
    if (managerTopicError || !managerTopic) {
      result.failed++;
      result.details.push({ followupCaseId: "delivery-summary", status: "FAILED", reason: managerTopicError?.message || "manager_shadow_topic_missing" });
    } else {
      try {
        const group = managerTopic.telegram_pilot_groups as unknown as { telegram_chat_id: string | number };
        await new TelegramClient().sendToChat(String(group.telegram_chat_id), formatFollowupDeliverySummary(deliverySummary, new Date(), reviewResult.summaries), { parseMode: "HTML", messageThreadId: Number(managerTopic.message_thread_id) });
      } catch (error) {
        result.failed++;
        result.details.push({ followupCaseId: "delivery-summary", status: "FAILED", reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return result;
}
