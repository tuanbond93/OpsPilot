import { NextRequest, NextResponse } from "next/server";
import warehouseAssignments from "@/data/warehouse-assignments.generated.json";
import { createAdminClient } from "@/connectors/supabase";
import { authorizeApiRequest } from "@/security/api-security";

type WarehouseAssignment = { warehouseId: string; warehouseName: string; zone: string; province: string };
type FollowupCase = { id: string; incident_id: string; incident_key: string; current_state: string; latest_affected_order_count: number };
type Incident = { id: string; warehouse_id: string; warehouse_name: string | null; reason_name: string };
type IncidentSummary = { incident_id: string; followup_state: string | null };
type IncidentHistory = { incident_id: string; affected_order_count: number | null };
type Member = { id: string; group_id: string; warehouse_name: string | null; warehouse_names: unknown; zone_names: unknown };
type Group = { id: string; title: string; telegram_chat_id: string };
type Topic = { id: string; group_id: string; topic_title: string; province_name: string | null; is_escalation: boolean };
type Reminder = { followup_case_id: string; reminder_stage: string; status: string };

const PILOT_ZONE = "Miền Bắc 3";
const pendingStates: Record<string, string> = {
  FIRST_PUSH_PENDING: "FIRST",
  SECOND_PUSH_PENDING: "SECOND",
  THIRD_PUSH_PENDING: "THIRD",
  ESCALATION_PENDING: "ESCALATION",
};
const assignments = warehouseAssignments.warehouses as WarehouseAssignment[];
const assignmentById = new Map(assignments.map((item) => [String(item.warehouseId), item]));
const assignmentByName = new Map(assignments.map((item) => [item.warehouseName, item]));

function provinceKey(value: string | null | undefined) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").trim().toLocaleLowerCase("vi");
}
function values(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}
function memberMatches(member: Member, warehouseName: string, zoneName: string) {
  return [...values(member.warehouse_names), ...(member.warehouse_name ? [member.warehouse_name] : [])].includes(warehouseName)
    || values(member.zone_names).includes(zoneName);
}

export async function GET(request: NextRequest) {
  // This is a read-only diagnostic. Operators who can view the dashboard must
  // be able to see why an incident cannot be delivered; mapping edits remain
  // protected by MANAGE_SYSTEM on the parent admin route.
  const auth = await authorizeApiRequest(request, "VIEW_SYSTEM", { limit: 30, windowMs: 60_000 });
  if (!auth.ok) return auth.response;

  const client = createAdminClient();
  // The dashboard's incident_summary is authoritative for currently active
  // incidents.  followup_cases can legitimately be absent while the source
  // still has an incident; such a gap must be reported, never hidden as zero.
  const { data: summaries, error: summariesError } = await client.from("incident_summary")
    .select("incident_id, followup_state").limit(1000);
  if (summariesError) return NextResponse.json({ error: "TELEGRAM_COVERAGE_READ_FAILED", message: summariesError.message }, { status: 503 });
  let activeSummaries = (summaries || []) as IncidentSummary[];
  let incidentFallback: Array<Incident & { incident_key: string }> | null = null;
  if (!activeSummaries.length) {
    const { data: activeIncidents, error: activeIncidentsError } = await client.from("incidents")
      .select("id, incident_key, warehouse_id, warehouse_name, reason_name, status")
      .in("status", ["open", "monitoring"]).order("last_detected_at", { ascending: false }).limit(1000);
    if (activeIncidentsError) return NextResponse.json({ error: "TELEGRAM_COVERAGE_READ_FAILED", message: activeIncidentsError.message }, { status: 503 });
    incidentFallback = (activeIncidents || []) as Array<Incident & { incident_key: string }>;
    activeSummaries = incidentFallback.map((item) => ({ incident_id: item.id, followup_state: null }));
  }
  if (!activeSummaries.length) return NextResponse.json({ ok: true, source: "incidents_and_summary_empty", summary: { total: 0, ready: 0, attention: 0, paused: 0 }, cases: [] });
  const incidentIds = activeSummaries.map((item) => item.incident_id);

  const [{ data: cases, error: casesError }, { data: incidents, error: incidentsError }, { data: histories, error: historiesError }, { data: members, error: membersError }, { data: groups, error: groupsError }, { data: topics, error: topicsError }] = await Promise.all([
    client.from("followup_cases").select("id, incident_id, incident_key, current_state, latest_affected_order_count").in("incident_id", incidentIds),
    incidentFallback ? Promise.resolve({ data: incidentFallback, error: null }) : client.from("incidents").select("id, incident_key, warehouse_id, warehouse_name, reason_name").in("id", incidentIds),
    client.from("incident_history").select("incident_id, affected_order_count").in("incident_id", incidentIds).order("recorded_at", { ascending: false }),
    client.from("telegram_pilot_members").select("id, group_id, warehouse_name, warehouse_names, zone_names").eq("status", "ACTIVE"),
    client.from("telegram_pilot_groups").select("id, title, telegram_chat_id").eq("status", "ACTIVE"),
    client.from("telegram_pilot_topics").select("id, group_id, topic_title, province_name, is_escalation").eq("status", "ACTIVE"),
  ]);
  const error = casesError || incidentsError || historiesError || membersError || groupsError || topicsError;
  if (error) return NextResponse.json({ error: "TELEGRAM_COVERAGE_READ_FAILED", message: error.message }, { status: 503 });

  const followupCases = (cases || []) as FollowupCase[];
  const { data: reminders, error: remindersError } = followupCases.length
    ? await client.from("telegram_followup_reminders").select("followup_case_id, reminder_stage, status").in("followup_case_id", followupCases.map((item) => item.id))
    : { data: [], error: null };
  if (remindersError) return NextResponse.json({ error: "TELEGRAM_COVERAGE_READ_FAILED", message: remindersError.message }, { status: 503 });

  const incidentById = new Map((incidents || []).map((item) => [item.id, item as Incident & { incident_key: string }]));
  const followupByIncident = new Map(followupCases.map((item) => [item.incident_id, item]));
  const latestCountByIncident = new Map<string, number>();
  for (const history of (histories || []) as IncidentHistory[]) if (!latestCountByIncident.has(history.incident_id)) latestCountByIncident.set(history.incident_id, Number(history.affected_order_count || 0));
  const activeGroups = new Map((groups || []).map((item) => [item.id, item as Group]));
  const activeMembers = (members || []) as Member[];
  const activeTopics = (topics || []) as Topic[];
  const reminderKeys = new Set((reminders || []).filter((item: Reminder) => item.status === "SENT" || item.status === "PENDING")
    .map((item: Reminder) => `${item.followup_case_id}:${item.reminder_stage}`));

  const report = activeSummaries.map((summary) => {
    const savedCase = followupByIncident.get(summary.incident_id);
    const incident = incidentById.get(summary.incident_id);
    const followupCase = savedCase || { id: `missing:${summary.incident_id}`, incident_id: summary.incident_id, incident_key: incident?.incident_key || `INC-${summary.incident_id.slice(0, 8)}`, current_state: summary.followup_state || "NEW", latest_affected_order_count: latestCountByIncident.get(summary.incident_id) || 0 };
    const assignment = incident && (assignmentById.get(String(incident.warehouse_id)) || assignmentByName.get(String(incident.warehouse_name || "")));
    const warehouseName = assignment?.warehouseName || incident?.warehouse_name || "Kho chưa xác định";
    const zoneName = assignment?.zone || "Chưa gán vùng";
    const provinceName = assignment?.province || "Chưa xác định";
    const base = { caseId: followupCase.id, incidentKey: followupCase.incident_key, warehouseName, provinceName, zoneName, reasonName: incident?.reason_name || "Nguyên nhân chưa xác định", state: followupCase.current_state, affectedOrderCount: followupCase.latest_affected_order_count };
    if (!incident || !assignment) return { ...base, status: "BLOCKED", reason: "Không xác định được kho để gán vùng/tỉnh.", action: "Bổ sung warehouse_id hoặc mapping kho." };
    if (zoneName !== PILOT_ZONE) return { ...base, status: "OUT_OF_SCOPE", reason: `Ngoài phạm vi ${PILOT_ZONE}.`, action: "Không gửi từ pilot này." };
    if (!savedCase) return { ...base, status: "BLOCKED", reason: "Sự cố đang có trên dashboard nhưng chưa có record follow-up để vào hàng đợi Telegram.", action: "Kiểm tra job đồng bộ/follow-up cycle và tạo lại follow-up case." };
    if (followupCase.current_state === "RILLNET_CHANGE_PAUSED") return { ...base, status: "PAUSED", reason: "Rillnet đã đổi trạng thái sau lần nhắc gần nhất.", action: "Rà soát evidence rồi xác nhận tiếp tục theo dõi." };
    const stage = pendingStates[followupCase.current_state];
    if (!stage) return { ...base, status: "NOT_DUE", reason: `Case đang ở ${followupCase.current_state}, chưa vào hàng đợi gửi.`, action: "Chờ snapshot mới hoặc mốc nhắc tiếp theo." };
    const matchedMembers = activeMembers.filter((member) => memberMatches(member, warehouseName, zoneName));
    if (!matchedMembers.length) return { ...base, status: "BLOCKED", reason: "Không có thành viên Telegram active khớp kho/vùng.", action: "Kích hoạt và gán vùng/kho cho đầu mối." };
    const recipientGroups = [...new Set(matchedMembers.map((member) => member.group_id).filter((id) => activeGroups.has(id)))];
    if (!recipientGroups.length) return { ...base, status: "BLOCKED", reason: "Đầu mối có mapping nhưng group Telegram chưa active.", action: "Kích hoạt group của đầu mối." };
    if (recipientGroups.length > 1) return { ...base, status: "BLOCKED", reason: `Có ${recipientGroups.length} group cùng khớp phạm vi.`, action: "Chỉ định một group nhận tin cho kho/vùng này." };
    const groupId = recipientGroups[0];
    const provinceTopic = activeTopics.find((topic) => topic.group_id === groupId && provinceKey(topic.province_name) === provinceKey(provinceName));
    const escalationTopic = activeTopics.find((topic) => topic.group_id === groupId && topic.is_escalation);
    const topic = provinceTopic || escalationTopic;
    if (!topic) return { ...base, status: "BLOCKED", reason: `Chưa có topic active cho tỉnh ${provinceName}.`, action: "Map và kích hoạt topic tỉnh trong Telegram Pilot." };
    if (reminderKeys.has(`${followupCase.id}:${stage}`)) return { ...base, status: "ALREADY_SENT", reason: `Đã có bản ghi gửi/chờ gửi cho lượt ${stage}.`, action: "Không gửi lại để tránh trùng." };
    return { ...base, status: "READY", reason: provinceTopic ? `Đủ điều kiện; sẽ gửi vào topic ${topic.topic_title}.` : `Đủ điều kiện nhưng đang dùng topic Escalation: ${topic.topic_title}.`, action: provinceTopic ? "Sẵn sàng gửi ở lượt cron kế tiếp." : "Nên map topic riêng cho tỉnh để phân luồng rõ hơn." };
  });
  const summary = { total: report.filter((item) => item.zoneName === PILOT_ZONE).length, ready: report.filter((item) => item.status === "READY").length, attention: report.filter((item) => item.status === "BLOCKED").length, paused: report.filter((item) => item.status === "PAUSED").length };
  return NextResponse.json({ ok: true, source: incidentFallback ? "active_incidents_fallback" : "incident_summary", summary, cases: report });
}
