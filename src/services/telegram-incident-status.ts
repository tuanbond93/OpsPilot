import type { SupabaseClient } from "@supabase/supabase-js";
import warehouseAssignments from "@/data/warehouse-assignments.generated.json";
import { TelegramClient } from "@/integrations/telegram";
import { formatIncidentStatusUpdate, formatSyncHeartbeat, type IncidentStatusLine } from "@/integrations/telegram/incident-status-message";

type Assignment = { warehouseId: string; warehouseName: string; zone: string; province: string };
type Followup = { id: string; incident_id: string; current_state: string; latest_affected_order_count: number; resolved_at: string | null };
type Incident = { id: string; warehouse_id: string; warehouse_name: string; reason_name: string };
type History = { incident_id: string; sync_run_id: string; affected_order_count: number; recorded_at: string };
type Topic = { group_id: string; message_thread_id: number; province_name: string | null; is_escalation: boolean; is_manager_decision: boolean; telegram_pilot_groups: { telegram_chat_id: string | number; status: string } };

const assignments = warehouseAssignments.warehouses as Assignment[];
const assignmentById = new Map(assignments.map((item) => [String(item.warehouseId), item]));
const assignmentByName = new Map(assignments.map((item) => [item.warehouseName, item]));
const key = (value: string | null | undefined) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").trim().toLowerCase();

export async function sendIncidentSyncStatus(client: SupabaseClient, syncRunId: string, completedAt: string) {
  const result = { active: 0, changed: 0, unchanged: 0, resolved: 0, sentBatches: 0, failed: 0, skipped: 0 };
  const [{ data: followups, error: followupError }, { data: topics, error: topicError }] = await Promise.all([
    client.from("followup_cases").select("id,incident_id,current_state,latest_affected_order_count,resolved_at").limit(1000),
    client.from("telegram_pilot_topics").select("group_id,message_thread_id,province_name,is_escalation,is_manager_decision,telegram_pilot_groups!inner(telegram_chat_id,status)").eq("status", "ACTIVE").eq("telegram_pilot_groups.status", "ACTIVE"),
  ]);
  if (followupError || topicError) throw followupError || topicError;
  const rows = (followups || []) as Followup[];
  if (!rows.length) return result;
  const { data: incidents, error: incidentError } = await client.from("incidents").select("id,warehouse_id,warehouse_name,reason_name").in("id", rows.map((item) => item.incident_id));
  if (incidentError) throw incidentError;
  const incidentById = new Map(((incidents || []) as Incident[]).map((item) => [item.id, item]));
  const pilot = rows.filter((item) => {
    const incident = incidentById.get(item.incident_id); const assignment = incident && (assignmentById.get(String(incident.warehouse_id)) || assignmentByName.get(incident.warehouse_name));
    return assignment?.zone === "Miền Bắc 3";
  });
  const { data: histories, error: historyError } = await client.rpc("get_recent_incident_histories", { p_incident_ids: pilot.map((item) => item.incident_id), p_limit_per_incident: 2 });
  if (historyError) throw historyError;
  const historyByIncident = new Map<string, History[]>();
  for (const history of (histories || []) as History[]) historyByIncident.set(history.incident_id, [...(historyByIncident.get(history.incident_id) || []), history].sort((a, b) => b.recorded_at.localeCompare(a.recorded_at)));
  const active = pilot.filter((item) => !["RESOLVED", "CLOSED"].includes(item.current_state));
  const newlyResolved = pilot.filter((item) => ["RESOLVED", "CLOSED"].includes(item.current_state) && historyByIncident.get(item.incident_id)?.[0]?.sync_run_id === syncRunId);
  result.active = active.length;
  const candidates = [...active, ...newlyResolved];
  const batches = new Map<string, Array<{ followup: Followup; incident: Incident; topic: Topic; line: IncidentStatusLine; changed: boolean; resolved: boolean }>>();
  for (const followup of candidates) {
    const incident = incidentById.get(followup.incident_id); if (!incident) { result.skipped++; continue; }
    const assignment = assignmentById.get(String(incident.warehouse_id)) || assignmentByName.get(incident.warehouse_name);
    const allTopics = (topics || []) as unknown as Topic[];
    const topic = allTopics.find((item) => key(item.province_name) === key(assignment?.province)) || allTopics.find((item) => item.is_escalation);
    if (!topic) { result.failed++; continue; }
    const history = historyByIncident.get(incident.id) || [];
    const current = Number(history[0]?.affected_order_count ?? followup.latest_affected_order_count ?? 0);
    const previous = history[1] ? Number(history[1].affected_order_count) : null;
    const resolved = ["RESOLVED", "CLOSED"].includes(followup.current_state);
    const changed = resolved || previous === null || previous !== current;
    const batchKey = `${topic.group_id}:${topic.message_thread_id}`;
    const line = { warehouse: incident.warehouse_name, reason: incident.reason_name, previousCount: previous, currentCount: resolved ? 0 : current, resolved };
    (batches.get(batchKey) || (batches.set(batchKey, []), batches.get(batchKey)!)).push({ followup, incident, topic, line, changed, resolved });
  }
  for (const batch of batches.values()) {
    const pending = [] as typeof batch;
    for (const item of batch) {
      const { error } = await client.from("telegram_incident_status_updates").insert({ followup_case_id: item.followup.id, incident_id: item.incident.id, sync_run_id: syncRunId, update_kind: item.resolved ? "RESOLVED" : "ACTIVE", changed: item.changed, previous_affected_order_count: item.line.previousCount, current_affected_order_count: item.line.currentCount, group_id: item.topic.group_id, message_thread_id: item.topic.message_thread_id });
      if (!error) pending.push(item); else if (error.code === "23505") result.skipped++; else result.failed++;
    }
    if (!pending.length) continue;
    try {
      const first = pending[0]; const group = first.topic.telegram_pilot_groups;
      const sent = await new TelegramClient().sendToChat(String(group.telegram_chat_id), formatIncidentStatusUpdate(pending.map((item) => item.line), completedAt), { parseMode: "HTML", messageThreadId: first.topic.message_thread_id });
      const ids = pending.map((item) => item.followup.id);
      await client.from("telegram_incident_status_updates").update({ status: "SENT", telegram_message_id: Number(sent.messageId), sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("sync_run_id", syncRunId).in("followup_case_id", ids);
      result.sentBatches++; result.changed += pending.filter((item) => item.changed && !item.resolved).length; result.unchanged += pending.filter((item) => !item.changed).length; result.resolved += pending.filter((item) => item.resolved).length;
    } catch (error) {
      result.failed += pending.length; const reason = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
      await client.from("telegram_incident_status_updates").update({ status: "FAILED", failure_reason: reason, updated_at: new Date().toISOString() }).eq("sync_run_id", syncRunId).in("followup_case_id", pending.map((item) => item.followup.id));
    }
  }
  const managerTopic = ((topics || []) as unknown as Topic[]).find((item) => item.is_manager_decision) || null;
  if (managerTopic) {
    const report = await client.from("telegram_sync_status_reports").insert({ sync_run_id: syncRunId, telegram_chat_id: managerTopic.telegram_pilot_groups.telegram_chat_id, message_thread_id: managerTopic.message_thread_id, active_cases: result.active, changed_cases: result.changed, unchanged_cases: result.unchanged, resolved_cases: result.resolved }).select("id").single();
    if (!report.error) try {
      const sent = await new TelegramClient().sendToChat(String(managerTopic.telegram_pilot_groups.telegram_chat_id), formatSyncHeartbeat({ completedAt, ...result }), { parseMode: "HTML", messageThreadId: managerTopic.message_thread_id });
      await client.from("telegram_sync_status_reports").update({ status: "SENT", telegram_message_id: Number(sent.messageId), sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", report.data.id);
    } catch (error) { result.failed++; await client.from("telegram_sync_status_reports").update({ status: "FAILED", failure_reason: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000), updated_at: new Date().toISOString() }).eq("id", report.data.id); }
  }
  return result;
}
