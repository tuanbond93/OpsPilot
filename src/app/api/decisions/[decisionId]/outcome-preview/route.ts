import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { authorizeDecisionScope } from "@/security/scope-guard";

export async function GET(request: NextRequest, { params }: { params: Promise<{ decisionId: string }> }) {
  const { decisionId } = await params;
  const scoped = await authorizeDecisionScope(request, decisionId, "VIEW_SYSTEM");
  if (!scoped.ok) return scoped.response;
  const db = createAdminClient();
  const { data: decision, error } = await db.from("decisions").select("id,incident_id,decision_status").eq("id", decisionId).maybeSingle();
  if (error) return NextResponse.json({ error: "OUTCOME_PREVIEW_FAILED", message: error.message }, { status: 500 });
  if (!decision) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  const [{ data: contract }, { data: verification }] = await Promise.all([
    db.from("decision_outcome_observation_contracts").select("id,baseline_snapshot,measurement_window_end").eq("decision_id", decisionId).maybeSingle(),
    db.from("decision_outcome_verifications").select("classification,reason_code,observed_at,evidence_refs,observed_affected_orders").eq("decision_id", decisionId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (!contract) return NextResponse.json({ ok: true, data: { state: "NO_CONTRACT", verification: verification || null } });
  const baselineFacts = (contract.baseline_snapshot as Record<string, any>)?.operationalFacts || {};
  const baseline = Number(baselineFacts.affectedOrders ?? baselineFacts.affectedOrderCount);
  const baselineAffectedOrders = Number.isFinite(baseline) ? baseline : null;
  const measurementWindowEnd = contract.measurement_window_end;
  const measurementReady = Date.now() >= new Date(measurementWindowEnd).getTime();
  let latestHistory: Record<string, any> | null = null;
  if (decision.incident_id) {
    const { data } = await db.from("incident_history").select("id,affected_order_count,recorded_at,sync_run_id").eq("incident_id", decision.incident_id).order("recorded_at", { ascending: false }).limit(1).maybeSingle();
    latestHistory = data;
  }
  const observed = Number(latestHistory?.affected_order_count);
  const observedAffectedOrders = Number.isFinite(observed) ? observed : null;
  return NextResponse.json({ ok: true, data: {
    state: verification ? "VERIFIED" : measurementReady ? "READY_TO_VERIFY" : "WAITING_MEASUREMENT_WINDOW",
    measurementWindowEnd, baselineAffectedOrders, observedAffectedOrders,
    observedAt: latestHistory?.recorded_at || null,
    source: latestHistory ? `incident_history:${latestHistory.sync_run_id || latestHistory.id}` : null,
    evidenceRefs: latestHistory ? [`incident_history:${latestHistory.id}`] : [],
    verification: verification || null,
  } });
}
