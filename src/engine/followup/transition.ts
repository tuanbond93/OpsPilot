import type { FollowupRepository } from "../../connectors/supabase";
import type { FollowupState, ProgressAssessment, TransitionResult } from "./types";

export interface ProcessTransitionParams {
  incidentId: string; // UUID FK
  incidentKey: string;
  firstDetectedAt: string;
  baselineCount: number;
  latestCount: number;
  changePercent: number;
  assessment: ProgressAssessment;
  transitionResult: TransitionResult;
  snapshotId?: string;
  referenceTimeMs?: number;
}

/**
 * Handles state transitions by persisting case status and appending immutable audit events
 */
export async function executeStateTransition(
  params: ProcessTransitionParams,
  repo?: FollowupRepository | null
): Promise<{ caseId?: string; transitioned: boolean }> {
  const refTimeIso = new Date(params.referenceTimeMs || Date.now()).toISOString();

  let resolvedAt: string | null = null;
  let closedAt: string | null = null;

  if (params.transitionResult.newState === "RESOLVED") {
    resolvedAt = refTimeIso;
  }
  if (params.transitionResult.newState === "CLOSED") {
    closedAt = refTimeIso;
  }

  if (repo) {
    const payload: any = {
      incident_id: params.incidentId,
      incident_key: params.incidentKey,
      current_state: params.transitionResult.newState,
      first_detected_at: params.firstDetectedAt,
      last_checked_at: refTimeIso,
      baseline_affected_order_count: params.baselineCount,
      latest_affected_order_count: params.latestCount,
      current_progress_percent: params.changePercent,
      current_assessment: params.assessment,
    };

    if (params.transitionResult.nextActionAt !== undefined) {
      payload.next_action_at = params.transitionResult.nextActionAt;
    }
    if (params.transitionResult.actionRequestedAt !== undefined) {
      payload.last_action_requested_at = params.transitionResult.actionRequestedAt;
    }
    if (params.transitionResult.actionConfirmedAt !== undefined) {
      payload.last_action_confirmed_at = params.transitionResult.actionConfirmedAt;
    }
    if (resolvedAt) payload.resolved_at = resolvedAt;
    if (closedAt) payload.closed_at = closedAt;

    const updatedCase = await repo.upsertCase(payload);

    await repo.insertEvent({
      followup_case_id: updatedCase.id,
      event_type: params.transitionResult.eventType,
      event_time: refTimeIso,
      snapshot_id: params.snapshotId || null,
      old_state: params.transitionResult.oldState,
      new_state: params.transitionResult.newState,
      assessment: params.assessment,
      confirmed_by: params.transitionResult.confirmedBy || null,
      notes: params.transitionResult.notes,
    });

    return { caseId: updatedCase.id, transitioned: true };
  }

  return { transitioned: true };
}
