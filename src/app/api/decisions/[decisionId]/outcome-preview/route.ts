import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { selectPostWindowOutcomeEvidence } from "@/domain/decision/outcome-evidence";
import { authorizeDecisionScope } from "@/security/scope-guard";

export async function GET(request: NextRequest, { params }: { params: Promise<{ decisionId: string }> }) {
  const { decisionId } = await params;
  const scoped = await authorizeDecisionScope(request, decisionId, "VIEW_SYSTEM");
  if (!scoped.ok) return scoped.response;
  const db = createAdminClient();
  const { data: decision, error } = await db.from("decisions").select("id,incident_id,decision_status").eq("id", decisionId).maybeSingle();
  if (error) return NextResponse.json({ error: "OUTCOME_PREVIEW_FAILED", message: error.message }, { status: 500 });
  if (!decision) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  const [{ data: contract }, { data: verification }, { data: auditEvents }] = await Promise.all([
    db.from("decision_outcome_observation_contracts").select("id,baseline_snapshot,measurement_window_end").eq("decision_id", decisionId).maybeSingle(),
    db.from("decision_outcome_verifications").select("classification,reason_code,observed_at,evidence_refs,observed_affected_orders").eq("decision_id", decisionId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("decision_audit_events").select("occurred_at,metadata").eq("decision_id", decisionId).order("occurred_at", { ascending: false }).limit(20),
  ]);
  if (!contract) return NextResponse.json({ ok: true, data: { state: "NO_CONTRACT", verification: verification || null } });
  const baselineFacts = (contract.baseline_snapshot as Record<string, any>)?.operationalFacts || {};
  const baseline = Number(baselineFacts.affectedOrders ?? baselineFacts.affectedOrderCount);
  const baselineAffectedOrders = Number.isFinite(baseline) ? baseline : null;
  const measurementWindowEnd = contract.measurement_window_end;
  const measurementReady = Date.now() >= new Date(measurementWindowEnd).getTime();
  let latestHistory: Record<string, any> | null = null;
  let incident: Record<string, any> | null = null;
  if (decision.incident_id) {
    const [historyResult, incidentResult] = await Promise.all([
      db.from("incident_history").select("id,affected_order_count,recorded_at,sync_run_id").eq("incident_id", decision.incident_id).gte("recorded_at", measurementWindowEnd).order("recorded_at", { ascending: false }).limit(1).maybeSingle(),
      db.from("incidents").select("id,status,resolved_at").eq("id", decision.incident_id).maybeSingle(),
    ]);
    latestHistory = historyResult.data;
    incident = incidentResult.data;
  }
  const evidence = selectPostWindowOutcomeEvidence(measurementWindowEnd,
    latestHistory ? { id: latestHistory.id, syncRunId: latestHistory.sync_run_id, affectedOrderCount: Number(latestHistory.affected_order_count), recordedAt: latestHistory.recorded_at } : null,
    incident ? { incidentId: incident.id, status: incident.status, resolvedAt: incident.resolved_at } : null);
  const shadowFollowup = (auditEvents || []).find((event) => event.metadata?.event === "LC10_SHADOW_FOLLOWUP_OBSERVED") || null;
  return NextResponse.json({ ok: true, data: {
    state: verification ? "VERIFIED" : !measurementReady ? "WAITING_MEASUREMENT_WINDOW" : evidence ? "READY_TO_VERIFY" : "AWAITING_POST_WINDOW_EVIDENCE",
    measurementWindowEnd, baselineAffectedOrders, observedAffectedOrders: evidence?.observedAffectedOrders ?? null,
    observedAt: evidence?.observedAt || null, source: evidence?.source || null, evidenceRefs: evidence?.evidenceRefs || [],
    evidenceKind: evidence?.kind || null,
    shadowFollowup: shadowFollowup ? { occurredAt: shadowFollowup.occurred_at, observationState: shadowFollowup.metadata.observationState, observedAt: shadowFollowup.metadata.observedAt, observedAffectedOrders: shadowFollowup.metadata.observedAffectedOrders, source: shadowFollowup.metadata.source } : null,
    verification: verification || null,
  } });
}
