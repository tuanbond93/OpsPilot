import type {
  FollowupCaseUpsert,
  FollowupEventInsert,
  IFollowupRepository,
} from "@/repositories/interfaces/IFollowupRepository";
import type { ProgressAssessment, TransitionResult } from "./types";

export interface ProcessTransitionParams {
  incidentId: string;
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

export function buildCaseMutation(params: ProcessTransitionParams): FollowupCaseUpsert {
  const refTimeIso = new Date(params.referenceTimeMs || Date.now()).toISOString();
  const payload: FollowupCaseUpsert = {
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
  if (params.transitionResult.newState === "RESOLVED") {
    payload.resolved_at = refTimeIso;
  }
  if (params.transitionResult.newState === "CLOSED") {
    payload.closed_at = refTimeIso;
  }

  return payload;
}

export function buildEventMutation(
  params: ProcessTransitionParams,
  followupCaseId: string
): FollowupEventInsert {
  const refTimeIso = new Date(params.referenceTimeMs || Date.now()).toISOString();

  return {
    followup_case_id: followupCaseId,
    event_type: params.transitionResult.eventType,
    event_time: refTimeIso,
    snapshot_id: params.snapshotId || null,
    old_state: params.transitionResult.oldState,
    new_state: params.transitionResult.newState,
    assessment: params.assessment,
    confirmed_by: params.transitionResult.confirmedBy || null,
    notes: params.transitionResult.notes,
  };
}

/**
 * Handles state transitions by persisting case status and appending immutable audit events.
 * This legacy single-row path remains available for callers outside the batched sync flow.
 */
export async function executeStateTransition(
  params: ProcessTransitionParams,
  repo?: IFollowupRepository | null
): Promise<{ caseId?: string; transitioned: boolean }> {
  if (repo) {
    const updatedCase = await repo.upsertCase(buildCaseMutation(params));
    await repo.insertEvent(buildEventMutation(params, updatedCase.id));
    return { caseId: updatedCase.id, transitioned: true };
  }

  return { transitioned: true };
}
