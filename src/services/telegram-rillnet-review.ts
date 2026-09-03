import type { SupabaseClient } from "@supabase/supabase-js";
import warehouseAssignments from "@/data/warehouse-assignments.generated.json";
import { TelegramClient } from "@/integrations/telegram";
import { rillnetReviewKeyboard, type RillnetReviewOutcome } from "@/integrations/telegram/rillnet-review-actions";

type Assignment = { warehouseId: string; warehouseName: string; zone: string; province: string };
type PausedCase = { id: string; incident_id: string; incident_key: string; latest_affected_order_count: number; current_assessment: string; current_rillnet_status_signature: string; last_action_rillnet_status_signature: string | null; rillnet_change_summary: string | null; rillnet_changed_at: string | null; rillnet_review_before_signature: string | null; rillnet_review_after_signature: string | null; rillnet_review_detected_at: string | null; rillnet_review_snapshot_id: string | null; rillnet_review_order_codes: unknown };
type Incident = { id: string; warehouse_id: string; warehouse_name: string | null; reason_name: string };
type Member = { id: string; group_id: string; warehouse_name: string | null; warehouse_names: unknown; zone_names: unknown };
type Group = { id: string; telegram_chat_id: string };
type Topic = { group_id: string; message_thread_id: number; topic_title: string };
type History = { incident_id: string; sample_order_codes: unknown; oldest_order_code: string | null };

const PILOT_ZONE = "Miền Bắc 3";
const assignments = warehouseAssignments.warehouses as Assignment[];
const byId = new Map(assignments.map((item) => [String(item.warehouseId), item]));
const byName = new Map(assignments.map((item) => [item.warehouseName, item]));
const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");

function memberMatches(member: Member, warehouseName: string) {
  return [...list(member.warehouse_names), ...(member.warehouse_name ? [member.warehouse_name] : [])].includes(warehouseName)
    || list(member.zone_names).includes(PILOT_ZONE);
}

function readableSignature(signature: string | null) {
  try {
    const rows = JSON.parse(signature || "[]") as unknown;
    if (!Array.isArray(rows)) return signature || "Chưa có dữ liệu";
    return rows.map((row) => Array.isArray(row) ? `${String(row[0])}: ${Number(row[1] || 0)} đơn` : String(row)).join(", ") || "Chưa có dữ liệu";
  } catch { return signature || "Chưa có dữ liệu"; }
}

function signatureTotal(signature: string | null) {
  try {
    const rows = JSON.parse(signature || "[]") as unknown;
    return Array.isArray(rows) ? rows.reduce((sum, row) => sum + (Array.isArray(row) ? Number(row[1] || 0) : 0), 0) : 0;
  } catch { return 0; }
}

function proposedOutcome(beforeSignature: string, afterSignature: string): RillnetReviewOutcome {
  const before = signatureTotal(beforeSignature);
  const after = signatureTotal(afterSignature);
  if (after === 0) return "SUCCESS";
  if (after > before) return "FAILED";
  return "CONTINUE";
}

function proposalReason(beforeSignature: string, afterSignature: string, proposal: RillnetReviewOutcome) {
  const before = signatureTotal(beforeSignature);
  const count = signatureTotal(afterSignature);
  if (proposal === "SUCCESS") return "Snapshot mới không còn đơn bị ảnh hưởng; cần Manager đối chiếu mã mẫu trước khi đóng case.";
  if (proposal === "FAILED") return `Số đơn bị ảnh hưởng tăng từ ${before} lên ${count} sau lần nhắc; tín hiệu vận hành đang xấu đi.`;
  return `Số đơn bị ảnh hưởng giảm từ ${before} xuống ${count}, hoặc cơ cấu trạng thái đã đổi nhưng vẫn còn đơn; cần Manager kiểm tra thực tế.`;
}

const outcomeLabel: Record<RillnetReviewOutcome, string> = { SUCCESS: "Thành công", FAILED: "Thất bại", CONTINUE: "Cần theo dõi tiếp" };

export type RillnetReviewSummaryItem = {
  province: string;
  warehouse: string;
  affectedOrders: number;
  status: "SUCCESS" | "FAILED";
  error?: string;
};

export type RillnetReviewDispatchResult = { scanned: number; sent: number; skipped: number; failed: number; summaries: RillnetReviewSummaryItem[]; details: Array<{ followupCaseId: string; status: string; reason?: string }> };

export async function dispatchRillnetChangeReviews(client: SupabaseClient, actor = "telegram_rillnet_review"): Promise<RillnetReviewDispatchResult> {
  const result: RillnetReviewDispatchResult = { scanned: 0, sent: 0, skipped: 0, failed: 0, summaries: [], details: [] };
  const { data: paused, error: pausedError } = await client.from("followup_cases")
    .select("id, incident_id, incident_key, latest_affected_order_count, current_assessment, current_rillnet_status_signature, last_action_rillnet_status_signature, rillnet_change_summary, rillnet_changed_at, rillnet_review_before_signature, rillnet_review_after_signature, rillnet_review_detected_at, rillnet_review_snapshot_id, rillnet_review_order_codes")
    .eq("current_state", "RILLNET_CHANGE_PAUSED").order("rillnet_changed_at", { ascending: true }).limit(200);
  if (pausedError) throw pausedError;
  const cases = (paused || []) as PausedCase[];
  if (!cases.length) return result;
  const [{ data: incidents, error: incidentError }, { data: groups, error: groupError }, { data: topics, error: topicError }, { data: managers, error: memberError }, { data: histories, error: historyError }] = await Promise.all([
    client.from("incidents").select("id, warehouse_id, warehouse_name, reason_name").in("id", cases.map((item) => item.incident_id)),
    client.from("telegram_pilot_groups").select("id, telegram_chat_id").eq("status", "ACTIVE"),
    client.from("telegram_pilot_topics").select("group_id, message_thread_id, topic_title").eq("status", "ACTIVE").eq("is_manager_decision", true),
    client.from("telegram_pilot_members").select("id, group_id, warehouse_name, warehouse_names, zone_names").eq("status", "ACTIVE").eq("pilot_role", "MANAGER"),
    client.from("incident_history").select("incident_id, sample_order_codes, oldest_order_code").in("incident_id", cases.map((item) => item.incident_id)).order("recorded_at", { ascending: false }).limit(1000),
  ]);
  const readError = incidentError || groupError || topicError || memberError || historyError;
  if (readError) throw readError;
  const incidentById = new Map((incidents || []).map((item) => [item.id, item as Incident]));
  const groupById = new Map((groups || []).map((item) => [item.id, item as Group]));
  const topicByGroup = new Map((topics || []).map((item) => [item.group_id, item as Topic]));
  const historyByIncident = new Map<string, History>();
  for (const row of (histories || []) as History[]) if (!historyByIncident.has(row.incident_id)) historyByIncident.set(row.incident_id, row);
  result.scanned = cases.length;

  for (const item of cases) {
    const incident = incidentById.get(item.incident_id);
    const assignment = incident && (byId.get(String(incident.warehouse_id)) || byName.get(String(incident.warehouse_name || "")));
    if (!incident || !assignment || assignment.zone !== PILOT_ZONE) { result.skipped++; result.details.push({ followupCaseId: item.id, status: "SKIPPED", reason: "outside_scope_or_mapping_missing" }); continue; }
    const eligibleManagers = (managers || []).filter((member) => memberMatches(member as Member, assignment.warehouseName)) as Member[];
    const destinations = [...new Set(eligibleManagers.map((member) => member.group_id))]
      .map((groupId) => ({ group: groupById.get(groupId), topic: topicByGroup.get(groupId) }))
      .filter((destination): destination is { group: Group; topic: Topic } => Boolean(destination.group && destination.topic));
    if (destinations.length !== 1) { result.skipped++; result.details.push({ followupCaseId: item.id, status: "SKIPPED", reason: destinations.length ? "multiple_manager_destinations" : "manager_destination_missing" }); continue; }
    const destination = destinations[0];
    const beforeSignature = item.rillnet_review_before_signature || "";
    const afterSignature = item.rillnet_review_after_signature || "";
    if (!beforeSignature || !afterSignature || beforeSignature === afterSignature) {
      result.skipped++; result.details.push({ followupCaseId: item.id, status: "SKIPPED", reason: "frozen_evidence_missing_or_unchanged" }); continue;
    }
    const detectedAt = item.rillnet_review_detected_at || item.rillnet_changed_at || "unknown";
    const idempotencyKey = `rillnet-review:${item.id}:${detectedAt}:${afterSignature}`;
    const proposal = proposedOutcome(beforeSignature, afterSignature);
    const { data: existingRequest, error: existingError } = await client.from("telegram_rillnet_review_requests")
      .select("id, status").eq("idempotency_key", idempotencyKey).maybeSingle();
    if (existingError) throw existingError;
    let requestResult;
    if (existingRequest) {
      const existingStatus = String(existingRequest.status || "").trim().toUpperCase();
      if (!["FAILED", "PENDING"].includes(existingStatus)) {
        result.skipped++; result.details.push({ followupCaseId: item.id, status: "SKIPPED", reason: `already_requested:${existingStatus || "UNKNOWN"}` }); continue;
      }
      const retryResult = await client.from("telegram_rillnet_review_requests")
        .update({ status: "PENDING", failure_reason: null, updated_at: new Date().toISOString() })
        .eq("id", existingRequest.id);
      requestResult = { data: { id: existingRequest.id }, error: retryResult.error };
    } else {
      requestResult = await client.from("telegram_rillnet_review_requests").insert({
        followup_case_id: item.id, group_id: destination.group.id, message_thread_id: destination.topic.message_thread_id,
        status: "PENDING", proposed_outcome: proposal, rillnet_status_signature: afterSignature,
        before_signature: beforeSignature, after_signature: afterSignature, detected_at: detectedAt,
        snapshot_id: item.rillnet_review_snapshot_id, order_codes: list(item.rillnet_review_order_codes),
        idempotency_key: idempotencyKey, created_by: actor,
      }).select("id").single();
    }
    if (requestResult.error) throw requestResult.error;
    if (!requestResult.data) throw new Error("TELEGRAM_RILLNET_REVIEW_REQUEST_NOT_CREATED");
    const request = requestResult.data;
    const history = historyByIncident.get(item.incident_id);
    const frozenCodes = list(item.rillnet_review_order_codes);
    const orderCodes = [...new Set(frozenCodes.length ? frozenCodes : [...list(history?.sample_order_codes), ...(history?.oldest_order_code ? [history.oldest_order_code] : [])])].slice(0, 5);
    const text = [
      "<b>RILLNET ĐÃ ĐỔI TRẠNG THÁI · MANAGER RÀ SOÁT</b>",
      `Kho: ${escapeHtml(assignment.warehouseName)} (${escapeHtml(assignment.province)})`,
      `Sự cố: ${escapeHtml(incident.reason_name)}`,
      `Số đơn tại lúc thay đổi: <b>${signatureTotal(afterSignature)}</b>`,
      `Trước khi nhắc: ${escapeHtml(readableSignature(beforeSignature))}`,
      `Snapshot phát hiện thay đổi: ${escapeHtml(readableSignature(afterSignature))}`,
      `Phát hiện lúc: ${escapeHtml(detectedAt)}`,
      `Mã đơn mẫu: ${orderCodes.length ? orderCodes.map(escapeHtml).join(", ") : "Chưa có trong snapshot"}`,
      "",
      `OpsPilot đề xuất: <b>${outcomeLabel[proposal]}</b>`,
      `Lý do đề xuất: ${escapeHtml(proposalReason(beforeSignature, afterSignature, proposal))}`,
      "Manager kiểm tra thực tế và chọn kết quả bên dưới. Không chọn nếu chưa đủ bằng chứng.",
    ].join("\n");
    try {
      const sent = await new TelegramClient().sendToChat(String(destination.group.telegram_chat_id), text, { parseMode: "HTML", messageThreadId: destination.topic.message_thread_id, inlineKeyboard: rillnetReviewKeyboard(request.id, orderCodes) });
      const now = new Date().toISOString();
      const { error: updateError } = await client.from("telegram_rillnet_review_requests").update({ status: "SENT", telegram_message_id: Number(sent.messageId), sent_at: now, updated_at: now }).eq("id", request.id);
      if (updateError) throw updateError;
      result.sent++;
      result.summaries.push({ province: assignment.province, warehouse: assignment.warehouseName, affectedOrders: signatureTotal(afterSignature), status: "SUCCESS" });
      result.details.push({ followupCaseId: item.id, status: "SENT" });
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
      await client.from("telegram_rillnet_review_requests").update({ status: "FAILED", failure_reason: reason, updated_at: new Date().toISOString() }).eq("id", request.id);
      result.failed++;
      result.summaries.push({ province: assignment.province, warehouse: assignment.warehouseName, affectedOrders: signatureTotal(afterSignature), status: "FAILED", error: reason });
      result.details.push({ followupCaseId: item.id, status: "FAILED", reason });
    }
  }
  return result;
}
