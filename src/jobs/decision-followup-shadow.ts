import { createAdminClient } from "@/connectors/supabase";
import { buildDecisionFollowupShadowPlan } from "@/domain/decision/followup-shadow";
import { selectPostWindowOutcomeEvidence } from "@/domain/decision/outcome-evidence";

export interface DecisionFollowupShadowJobResult {
  ok: boolean; timestamp: string; scannedCount: number; capturedCount: number; awaitingEvidenceCount: number; skippedCount: number; failedCount: number; errors: string[];
}

/** LC-10 capture only: never verifies outcomes, transitions decisions, dispatches work, or writes financial values. */
export async function runDecisionFollowupShadowJob(referenceTimeMs = Date.now(), actor = "decision-followup-runner"): Promise<DecisionFollowupShadowJobResult> {
  const timestamp = new Date(referenceTimeMs).toISOString();
  const result: DecisionFollowupShadowJobResult = { ok: true, timestamp, scannedCount: 0, capturedCount: 0, awaitingEvidenceCount: 0, skippedCount: 0, failedCount: 0, errors: [] };
  try {
    const db = createAdminClient();
    const { data: schedules, error } = await db.from("decision_followup_schedules")
      .select("id,check_at,decision_id,decisions!inner(id,incident_id,decision_status,decision_mode,decision_outcome_observation_contracts(id,measurement_window_end))")
      .eq("status", "SCHEDULED").lte("check_at", timestamp).limit(100);
    if (error) throw error;
    for (const schedule of schedules || []) {
      result.scannedCount += 1;
      try {
        const decision = Array.isArray(schedule.decisions) ? schedule.decisions[0] : schedule.decisions;
        const contract = Array.isArray(decision?.decision_outcome_observation_contracts) ? decision.decision_outcome_observation_contracts[0] : decision?.decision_outcome_observation_contracts;
        if (!decision || !contract?.measurement_window_end) { result.skippedCount += 1; continue; }
        const incidentId = decision.incident_id as string | null;
        const [historyResult, incidentResult] = incidentId ? await Promise.all([
          db.from("incident_history").select("id,affected_order_count,recorded_at,sync_run_id").eq("incident_id", incidentId).gte("recorded_at", contract.measurement_window_end).order("recorded_at", { ascending: false }).limit(1).maybeSingle(),
          db.from("incidents").select("id,status,resolved_at").eq("id", incidentId).maybeSingle(),
        ]) : [{ data: null }, { data: null }];
        if (historyResult.error) throw historyResult.error;
        if (incidentResult.error) throw incidentResult.error;
        const history = historyResult.data;
        const incident = incidentResult.data;
        const evidence = selectPostWindowOutcomeEvidence(contract.measurement_window_end,
          history ? { id: history.id, syncRunId: history.sync_run_id, affectedOrderCount: Number(history.affected_order_count), recordedAt: history.recorded_at } : null,
          incident ? { incidentId: incident.id, status: incident.status, resolvedAt: incident.resolved_at } : null);
        const plan = buildDecisionFollowupShadowPlan({ scheduleId: schedule.id, checkAt: schedule.check_at, now: timestamp, decisionStatus: decision.decision_status, decisionMode: decision.decision_mode, evidence });
        if (plan.kind === "SKIP") { result.skippedCount += 1; continue; }
        const { error: auditError } = await db.from("decision_audit_events").upsert({
          decision_id: decision.id, idempotency_key: plan.idempotencyKey, actor,
          previous_status: decision.decision_status, new_status: decision.decision_status,
          metadata: { event: "LC10_SHADOW_FOLLOWUP_OBSERVED", runnerMode: "SHADOW", observationState: plan.observationState, scheduleId: schedule.id, scheduleCheckAt: schedule.check_at, observedAt: plan.evidence?.observedAt || null, observedAffectedOrders: plan.evidence?.observedAffectedOrders ?? null, source: plan.evidence?.source || null, evidenceRefs: plan.evidence?.evidenceRefs || [] },
        }, { onConflict: "decision_id,idempotency_key", ignoreDuplicates: true });
        if (auditError) throw auditError;
        if (plan.observationState === "READY_TO_VERIFY") result.capturedCount += 1;
        else result.awaitingEvidenceCount += 1;
      } catch (caught) {
        result.failedCount += 1;
        result.errors.push(`Schedule ${schedule.id}: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    }
  } catch (caught) {
    result.ok = false; result.failedCount += 1; result.errors.push(caught instanceof Error ? caught.message : String(caught));
  }
  return result;
}
