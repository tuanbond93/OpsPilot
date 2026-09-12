import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { syncRillnet } from "@/jobs/sync-rillnet";
import { authorizeApiRequest, isCronAuthorized } from "@/security/api-security";
import { runTelegramFollowupPilotDispatch } from "@/services/telegram-followup-pilot";
import { dispatchRillnetChangeReviews } from "@/services/telegram-rillnet-review";
import { sendIncidentSyncStatus } from "@/services/telegram-incident-status";
import { atHour, localDay, localHour } from "@/domain/operational-learning/checkpoint-policy";
import { persistCheckpointDispatchAudit } from "@/services/checkpoint-dispatch-audit";
import { NearTermCapacityRuntimeService } from "@/services/near-term-capacity-runtime";
import { getRuntimeErrorDetails } from "@/observability/runtimeDiagnostics";
import { logger } from "@/observability/logger";
import { claimCheckpointRecovery, finishCheckpointRecovery, queueCheckpointRecovery } from "@/services/checkpoint-recovery";
import { isTransientInfrastructureError, retryTransientInfrastructure } from "@/services/transient-infrastructure";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function writeCheckpointAudit(input: Parameters<typeof persistCheckpointDispatchAudit>[1]) {
  try { await persistCheckpointDispatchAudit(createAdminClient(), input); }
  catch (error) {
    logger.error({ category: "OBSERVABILITY_FAILURE", component: "checkpoint_dispatch_audits", message: getRuntimeErrorDetails(error).message });
  }
}

function recoveryRequest(request: NextRequest): { checkpointAt: string; recoveryToken: string } | null {
  const checkpointAt = request.nextUrl.searchParams.get("checkpoint_at");
  const recoveryAttempt = request.nextUrl.searchParams.get("recovery_attempt");
  const recoveryToken = request.headers.get("x-opspilot-recovery-token");
  if (!checkpointAt && !recoveryAttempt && !recoveryToken) return null;
  if (recoveryAttempt !== "1" || !checkpointAt || !recoveryToken) return null;
  try {
    const normalizedCheckpointAt = new Date(checkpointAt).toISOString();
    return { checkpointAt: normalizedCheckpointAt, recoveryToken };
  } catch { return null; }
}

async function hasActiveSyncLock() {
  const { data, error } = await createAdminClient().from("sync_locks")
    .select("expires_at").eq("lock_key", "global:rillnet-sync").maybeSingle();
  if (error) throw error;
  return Boolean(data?.expires_at && new Date(data.expires_at).getTime() > Date.now());
}

function attention(checkpointAt: string, failureStage: string, attemptCount: number, error: unknown) {
  logger.error({
    category: "CHECKPOINT_FAILED_REQUIRES_ATTENTION",
    checkpointAt,
    failureStage,
    attemptCount,
    lastSafeError: getRuntimeErrorDetails(error).message.slice(0, 500),
  });
}

/**
 * One evidence-safe follow-up cycle.
 *
 * A Telegram reply is an explanation, not proof of resolution. This endpoint
 * always refreshes the source first; only then can the deterministic follow-up
 * state machine request a later reminder or mark an incident resolved. A
 * source snapshot that did not change never advances the reminder ladder.
 */
async function runFollowupCycle(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    const access = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 3, windowMs: 60_000 });
    if (!access.ok) return access.response;
  }

  const recovery = recoveryRequest(request);
  if (request.nextUrl.searchParams.has("recovery_attempt") && !recovery) {
    return NextResponse.json({ ok: false, error: "INVALID_RECOVERY_REQUEST" }, { status: 400 });
  }
  const nowMs = Date.now();
  const checkpointAt = recovery?.checkpointAt || new Date(atHour(localDay(nowMs), localHour(nowMs))).toISOString();
  const client = createAdminClient();
  if (recovery) {
    const claimed = await claimCheckpointRecovery(client, checkpointAt, recovery.recoveryToken);
    if (!claimed) return NextResponse.json({ ok: true, stage: "RECOVERY_ALREADY_CLAIMED" }, { status: 200 });
  }
  const sync = await syncRillnet({ checkpointAt });
  if (!sync.ok) {
    const status = sync.error?.code === "SYNC_ALREADY_RUNNING" ? 409 : 500;
    await writeCheckpointAudit({ checkpointAt, startedAt: sync.startedAt, completedAt: sync.completedAt, syncRunId: sync.syncRunId, executionStatus: "FAILED", httpStatus: status, errorCode: sync.error?.code, errorMessageSafe: sync.error?.message });
    if (recovery) {
      await finishCheckpointRecovery(client, checkpointAt, recovery.recoveryToken, { status: "FAILED", failureStage: "SYNC", lastSafeError: sync.error?.message || "Recovery sync failed" });
      attention(checkpointAt, "SYNC", 2, sync.error?.message || "Recovery sync failed");
    } else if (!sync.syncRunId && sync.error && isTransientInfrastructureError(sync.error)) {
      try {
        const activeLock = await retryTransientInfrastructure(hasActiveSyncLock);
        if (!activeLock.value) {
          await retryTransientInfrastructure(() => queueCheckpointRecovery(client, {
            checkpointAt,
            scheduledFor: new Date(Date.now() + 5 * 60_000).toISOString(),
            failureStage: "SYNC_LOCK_ACQUISITION",
            lastSafeError: sync.error!.message,
          }));
          logger.info({ category: "CHECKPOINT_RECOVERY_QUEUED", checkpointAt, recoveryAttempt: 1 });
        }
      } catch (error) {
        attention(checkpointAt, "RECOVERY_QUEUE", 1, error);
      }
    }
    return NextResponse.json({ ok: false, stage: "SYNC", sync }, { status });
  }

  if (recovery) {
    await finishCheckpointRecovery(client, checkpointAt, recovery.recoveryToken, { status: "SUCCEEDED", syncRunId: sync.syncRunId });
  }

  if (sync.skipped && sync.skipReason === "CHECKPOINT_ALREADY_COMPLETED") {
    return NextResponse.json({ ok: true, stage: "RECOVERY_ALREADY_COMPLETED", sync: { syncRunId: sync.syncRunId } });
  }

  // No new source evidence means the engine must not evaluate or remind again.
  if (sync.skipped || sync.skipReason === "SOURCE_UNCHANGED") {
    // A review may have been created by an earlier fresh snapshot immediately
    // before a deploy or transient Telegram failure. Deliver that human-review
    // request even when there is no newer operational evidence; never advance
    // the normal reminder ladder on an unchanged snapshot.
    let rillnetReviews;
    let rillnetReviewError: string | null = null;
    try { rillnetReviews = await dispatchRillnetChangeReviews(createAdminClient(), "followup_cycle_no_fresh_snapshot"); }
    catch (error) {
      rillnetReviewError = getRuntimeErrorDetails(error).message;
      rillnetReviews = { scanned: 0, sent: 0, skipped: 0, failed: 1, summaries: [], details: [{ status: "FAILED", reason: rillnetReviewError }] };
    }
    let statusUpdates = null;
    let statusUpdateError: string | null = null;
    if (sync.syncRunId) {
      try { statusUpdates = await sendIncidentSyncStatus(createAdminClient(), sync.syncRunId, sync.completedAt || new Date().toISOString()); }
      catch (error) {
        statusUpdateError = getRuntimeErrorDetails(error).message;
        statusUpdates = { active: null, changed: null, unchanged: null, resolved: null, sentBatches: null, failed: 1, skipped: null };
      }
    }
    await writeCheckpointAudit({
      checkpointAt, startedAt: sync.startedAt, completedAt: sync.completedAt, syncRunId: sync.syncRunId, executionStatus: "SUCCESS", httpStatus: 200,
      telegramScanned: 0, recipientsResolved: 0, interactionsCreated: 0, sendAttempts: 0, sendSuccess: 0, sendFailed: 0,
      statusUpdatesActive: statusUpdates?.active, statusUpdatesResolved: statusUpdates?.resolved,
      statusUpdateBatchesSent: statusUpdates?.sentBatches, statusUpdateBatchesFailed: statusUpdates?.failed,
      exclusionCounts: { NO_FRESH_EVIDENCE: 1 },
    });
    return NextResponse.json({
      ok: rillnetReviews.failed === 0 && (!statusUpdates || statusUpdates.failed === 0),
      stage: "NO_FRESH_SNAPSHOT",
      sync,
      telegram: { scanned: 0, sent: 0, coveredCases: 0, skipped: 0, deferred: 0, failed: 0 },
      rillnetReviews,
      statusUpdates,
      errors: { rillnetReviewError, statusUpdateError },
    });
  }

  const evaluation = sync.followupEvaluation;
  let telegram: Awaited<ReturnType<typeof runTelegramFollowupPilotDispatch>> | null = null;
  let statusUpdates: Awaited<ReturnType<typeof sendIncidentSyncStatus>> | null = null;
  try {
    telegram = await runTelegramFollowupPilotDispatch(createAdminClient(), "followup_cycle");
    statusUpdates = await sendIncidentSyncStatus(createAdminClient(), sync.syncRunId, sync.completedAt || new Date().toISOString());
  } catch (error) {
    await writeCheckpointAudit({
      checkpointAt, startedAt: sync.startedAt, completedAt: new Date().toISOString(), syncRunId: sync.syncRunId, executionStatus: "FAILED", httpStatus: 500,
      supportedCasesEvaluated: evaluation?.supportedCasesEvaluated, khoTonEvaluated: evaluation?.khoTonEvaluated, khoChuaLuanChuyenEvaluated: evaluation?.khoChuaLuanChuyenEvaluated,
      firstPushPendingCreated: evaluation?.pendingCreated.first, secondPushPendingCreated: evaluation?.pendingCreated.second,
      thirdPushPendingCreated: evaluation?.pendingCreated.third, escalationPendingCreated: evaluation?.pendingCreated.escalation,
      totalDispatchEligiblePending: evaluation ? Object.values(evaluation.pendingCreated).reduce((sum, value) => sum + value, 0) : null,
      telegramScanned: telegram?.scanned, recipientsResolved: telegram?.recipientsResolved, interactionsCreated: telegram?.interactionsCreated,
      sendAttempts: telegram?.sendAttempts, sendSuccess: telegram?.sent, sendFailed: telegram?.failed,
      statusUpdatesActive: statusUpdates?.active, statusUpdatesResolved: statusUpdates?.resolved,
      statusUpdateBatchesSent: statusUpdates?.sentBatches, statusUpdateBatchesFailed: statusUpdates?.failed,
      errorCode: "FOLLOWUP_CYCLE_DISPATCH_FAILED", errorMessageSafe: getRuntimeErrorDetails(error).message,
    });
    throw error;
  }
  // This shadow adapter is additive. A Phase 2 failure is logged but can never
  // turn a successful Phase 1 checkpoint into a failed checkpoint.
  let nearTermCapacity: Awaited<ReturnType<NearTermCapacityRuntimeService["runCheckpoint"]>> | null = null;
  try { nearTermCapacity = await new NearTermCapacityRuntimeService(createAdminClient()).runCheckpoint("followup_cycle"); }
  catch (error) {
    logger.error({ category: "PHASE2_SHADOW_FAILURE", component: "near_term_capacity", message: getRuntimeErrorDetails(error).message });
  }
  await writeCheckpointAudit({
    checkpointAt, startedAt: sync.startedAt, completedAt: sync.completedAt, syncRunId: sync.syncRunId, executionStatus: "SUCCESS", httpStatus: 200,
    supportedCasesEvaluated: evaluation?.supportedCasesEvaluated,
    khoTonEvaluated: evaluation?.khoTonEvaluated,
    khoChuaLuanChuyenEvaluated: evaluation?.khoChuaLuanChuyenEvaluated,
    firstPushPendingCreated: evaluation?.pendingCreated.first,
    secondPushPendingCreated: evaluation?.pendingCreated.second,
    thirdPushPendingCreated: evaluation?.pendingCreated.third,
    escalationPendingCreated: evaluation?.pendingCreated.escalation,
    totalDispatchEligiblePending: evaluation ? Object.values(evaluation.pendingCreated).reduce((sum, value) => sum + value, 0) : null,
    telegramScanned: telegram.scanned, recipientsResolved: telegram.recipientsResolved, interactionsCreated: telegram.interactionsCreated,
    sendAttempts: telegram.sendAttempts, sendSuccess: telegram.sent, sendFailed: telegram.failed,
    statusUpdatesActive: statusUpdates.active, statusUpdatesResolved: statusUpdates.resolved,
    statusUpdateBatchesSent: statusUpdates.sentBatches, statusUpdateBatchesFailed: statusUpdates.failed,
  });
  return NextResponse.json({
    ok: telegram.failed === 0,
    stage: "COMPLETE",
    sync: {
      syncRunId: sync.syncRunId,
      completedAt: sync.completedAt,
      durationMs: sync.durationMs,
      incidentCount: sync.incidentCount,
    },
    telegram,
    statusUpdates,
    nearTermCapacity,
  });
}

export async function GET(request: NextRequest) {
  return runFollowupCycle(request);
}

export async function POST(request: NextRequest) {
  return runFollowupCycle(request);
}
