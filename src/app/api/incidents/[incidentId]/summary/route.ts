import { NextRequest, NextResponse } from "next/server";
import { authorizeIncidentScope } from "@/security/scope-guard";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ incidentId: string }> }
) {
  const { incidentId } = await params;
  const guard = await authorizeIncidentScope(request, incidentId);
  if (!guard.ok) return guard.response;

  const db = guard.client;
  const { data: incident, error: incidentError } = await db.from("incidents")
    .select("id, incident_key, warehouse_id, warehouse_name, reason_code, reason_name, status, priority_score, first_detected_at, last_detected_at")
    .eq("id", guard.incident.id)
    .maybeSingle();
  if (incidentError) return NextResponse.json({ error: "INCIDENT_QUERY_FAILED", message: incidentError.message }, { status: 500 });
  if (!incident) return NextResponse.json({ error: "INCIDENT_NOT_FOUND" }, { status: 404 });

  const [historyResult, triageResult, followupResult, decisionResult] = await Promise.all([
    db.from("incident_history")
      .select("recorded_at, affected_order_count, average_age_hours, maximum_age_hours, oldest_order_code, sample_order_codes")
      .eq("incident_id", incident.id).order("recorded_at", { ascending: false }).limit(2),
    db.from("incident_triage_evaluations")
      .select("route, triage_reason, evidence, created_at")
      .eq("incident_id", incident.id).order("created_at", { ascending: false }).limit(1),
    db.from("followup_cases")
      .select("current_state, resolved_at, closed_at, current_progress_percent, current_assessment, next_action_at, last_checked_at, updated_at")
      .eq("incident_id", incident.id).order("updated_at", { ascending: false }).limit(1),
    db.from("decisions")
      .select("id, decision_status, approved_at, rejected_at, reject_reason, created_at, updated_at")
      .eq("incident_id", incident.id).order("created_at", { ascending: false }).limit(1),
  ]);
  const failed = [historyResult, triageResult, followupResult, decisionResult].find((result) => result.error);
  if (failed?.error) return NextResponse.json({ error: "INCIDENT_SUMMARY_QUERY_FAILED", message: failed.error.message }, { status: 500 });

  const history = (historyResult.data || []).map((row) => ({
    recordedAt: row.recorded_at,
    affectedOrderCount: row.affected_order_count,
    averageAgeHours: row.average_age_hours === null ? null : Number(row.average_age_hours),
    maximumAgeHours: row.maximum_age_hours === null ? null : Number(row.maximum_age_hours),
    oldestOrderCode: row.oldest_order_code || null,
    sampleOrderCodes: row.sample_order_codes || [],
  }));
  const latestHistory = history[0] || {};
  const triageRow = triageResult.data?.[0] || null;
  const followupRow = followupResult.data?.[0] || null;
  const decisionRow = decisionResult.data?.[0] || null;

  return NextResponse.json({
    incident: {
      incidentId: incident.id, incidentKey: incident.incident_key,
      warehouseId: incident.warehouse_id, warehouseName: incident.warehouse_name || "Kho chưa xác định",
      reasonCode: incident.reason_code, reasonName: incident.reason_name, status: incident.status,
      priorityScore: incident.priority_score, firstDetectedAt: incident.first_detected_at,
      lastDetectedAt: incident.last_detected_at,
      affectedOrderCount: latestHistory.affectedOrderCount ?? 0,
      averageAgeHours: latestHistory.averageAgeHours ?? null,
      maximumAgeHours: latestHistory.maximumAgeHours ?? null,
      oldestOrderCode: latestHistory.oldestOrderCode ?? null,
      sampleOrderCodes: latestHistory.sampleOrderCodes ?? [],
      latestSnapshotAt: latestHistory.recordedAt ?? null,
    },
    history,
    triage: triageRow ? { route: triageRow.route, triageReason: triageRow.triage_reason, evidence: triageRow.evidence || {}, createdAt: triageRow.created_at } : null,
    followup: followupRow ? {
      currentState: followupRow.current_state, resolvedAt: followupRow.resolved_at,
      closedAt: followupRow.closed_at,
      progressPercent: followupRow.current_progress_percent === null ? null : Number(followupRow.current_progress_percent),
      progressAssessment: followupRow.current_assessment, nextActionAt: followupRow.next_action_at,
      lastCheckedAt: followupRow.last_checked_at,
    } : null,
    decision: decisionRow ? {
      decisionId: decisionRow.id, decisionStatus: decisionRow.decision_status,
      approvedAt: decisionRow.approved_at, rejectedAt: decisionRow.rejected_at,
      rejectReason: decisionRow.reject_reason, createdAt: decisionRow.created_at,
      updatedAt: decisionRow.updated_at,
    } : null,
  });
}
