/**
 * Phase 3 — Case Material-State Fingerprint & Skip Unchanged/Not-Due Evaluation
 *
 * Computes deterministic material-state fingerprint using existing persisted fields only.
 *
 * Rule:
 * if (fingerprint == previous_fingerprint AND next_check_at > now) {
 *   skip heavy follow-up processing
 * }
 *
 * Heavy processing includes:
 * - evidence regeneration
 * - member generation
 * - decision regeneration
 * - AI call
 * - intervention generation
 *
 * Invariant: NEVER skip:
 * - changed case
 * - newly created case
 * - due case (next_check_at <= now or missing)
 * - unresolved case whose next_check_at has arrived
 * - terminal transition that must close an incident/outcome
 */

import { createHash } from "node:crypto";
import type { FollowupCaseRow } from "@/connectors/supabase/types";
import type { OperationalCohort } from "@/domain/operational-learning/checkpoint-policy";
import type { Incident } from "@/engine/incident";
import type { CaseMaterialFingerprintInput } from "./types";

export function isSkipUnchangedNotDueFeatureEnabled(): boolean {
  return process.env.SKIP_UNCHANGED_NOT_DUE_V0 === "true";
}

/**
 * Computes a deterministic SHA-256 fingerprint for a case's material operational state.
 */
export function computeMaterialFingerprint(input: CaseMaterialFingerprintInput): string {
  const sortedMembers = (input.memberCodes || []).slice().sort().join(",");
  const payload = [
    `status:${input.status}`,
    `members:${sortedMembers}`,
    `memberCount:${input.memberCount ?? 0}`,
    `backlogCount:${input.backlogCount ?? 0}`,
    `explanation:${input.explanationState ?? ""}`,
    `tracking:${input.latestTrackingState ?? ""}`,
    `slaAge:${input.slaAgeHours ?? 0}`,
    `priority:${input.priorityScore ?? 0}`,
    `reason:${input.reasonCode ?? ""}`,
    `warehouse:${input.warehouseId ?? ""}`,
  ].join("|");

  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Convenience builder from existing persisted entities.
 */
export function extractCaseFingerprintInput(
  caseRow: FollowupCaseRow,
  cohort?: OperationalCohort | null,
  incident?: Incident | null
): CaseMaterialFingerprintInput {
  const memberCodes = cohort?.members?.map((m) => m.orderCode)
    ?? (incident?.affectedOrders || []);

  return {
    status: caseRow.current_state,
    memberCodes,
    memberCount: cohort?.members?.length ?? memberCodes.length,
    backlogCount: cohort?.baselineCodes?.length ?? incident?.affectedOrderCount ?? caseRow.baseline_affected_order_count ?? 0,
    explanationState: caseRow.current_assessment ?? "",
    latestTrackingState: cohort?.members?.[0]?.status ?? "",
    slaAgeHours: incident?.maximumAgeHours ?? null,
    priorityScore: incident?.priorityScore ?? null,
    reasonCode: incident?.reasonCode ?? (caseRow.incident_key ? caseRow.incident_key.split(":")[1] : ""),
    warehouseId: incident?.warehouseId ?? (caseRow.incident_key ? caseRow.incident_key.split(":")[0] : ""),
  };
}

export interface ShouldSkipEvaluationParams {
  currentFingerprint: string;
  previousFingerprint?: string | null;
  nextCheckAt?: string | null;
  nowMs: number;
  isTerminalTransition?: boolean;
  isNewCase?: boolean;
}

export interface SkipEvaluationResult {
  skipHeavyProcessing: boolean;
  reason:
    | "NEW_CASE"
    | "TERMINAL_TRANSITION"
    | "STATE_CHANGED"
    | "DUE_FOR_RECHECK"
    | "UNCHANGED_AND_NOT_DUE";
}

/**
 * Determines whether heavy processing can be safely skipped for a case.
 */
export function evaluateCaseHeavyProcessingSkip(
  params: ShouldSkipEvaluationParams
): SkipEvaluationResult {
  // 1. Newly created cases must never be skipped
  if (params.isNewCase) {
    return { skipHeavyProcessing: false, reason: "NEW_CASE" };
  }

  // 2. Terminal transitions that must close an incident/outcome must never be skipped
  if (params.isTerminalTransition) {
    return { skipHeavyProcessing: false, reason: "TERMINAL_TRANSITION" };
  }

  // 3. Changed cases (fingerprint mismatch) must never be skipped
  const hasFingerprintMatch =
    Boolean(params.previousFingerprint) &&
    params.previousFingerprint === params.currentFingerprint;

  if (!hasFingerprintMatch) {
    return { skipHeavyProcessing: false, reason: "STATE_CHANGED" };
  }

  // 4. Due cases (next_check_at <= nowMs or next_check_at missing) must never be skipped
  const nextCheckMs = params.nextCheckAt ? Date.parse(params.nextCheckAt) : NaN;
  const isDue = !Number.isFinite(nextCheckMs) || nextCheckMs <= params.nowMs;

  if (isDue) {
    return { skipHeavyProcessing: false, reason: "DUE_FOR_RECHECK" };
  }

  // 5. Unchanged AND not-due case: Safe to skip heavy processing!
  return { skipHeavyProcessing: true, reason: "UNCHANGED_AND_NOT_DUE" };
}
