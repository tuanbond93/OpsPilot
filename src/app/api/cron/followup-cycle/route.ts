import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { syncRillnet } from "@/jobs/sync-rillnet";
import { authorizeApiRequest, isCronAuthorized } from "@/security/api-security";
import { runTelegramFollowupPilotDispatch } from "@/services/telegram-followup-pilot";
import { dispatchRillnetChangeReviews } from "@/services/telegram-rillnet-review";
import { sendIncidentSyncStatus } from "@/services/telegram-incident-status";
import { atHour, localDay, localHour } from "@/domain/operational-learning/checkpoint-policy";
import { persistCheckpointDispatchAudit } from "@/services/checkpoint-dispatch-audit";
import { getRuntimeErrorDetails } from "@/observability/runtimeDiagnostics";
import { logger } from "@/observability/logger";
import { claimCheckpointRecovery, finishCheckpointRecovery, queueCheckpointRecovery } from "@/services/checkpoint-recovery";
import { queuePhase2CheckpointWork } from "@/services/phase2-checkpoint-work";
import { isTransientInfrastructureError, retryTransientInfrastructure } from "@/services/transient-infrastructure";
import { runNaturalShadowObserverSafely } from "@/services/inbound-natural-shadow-observer";
import { CheckpointShadowRunner, type ShadowComputeResult, type ShadowParityReport } from "@/engine/checkpoint-v2/checkpoint-shadow-runner";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function writeCheckpointAudit(input: Parameters<typeof persistCheckpointDispatchAudit>[1]) {
  try {
    await persistCheckpointDispatchAudit(createAdminClient(), input);
    return true;
  }
  catch (error) {
    logger.error({ category: "OBSERVABILITY_FAILURE", component: "checkpoint_dispatch_audits", message: getRuntimeErrorDetails(error).message });
    return false;
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

function attention(checkpointAt: string, failureStage: string, failureClass: string, attemptCount: number, error: unknown) {
  logger.error({
    category: "CHECKPOINT_FAILED_REQUIRES_ATTENTION",
    checkpoint_at: checkpointAt,
    failure_stage: failureStage,
    failure_class: failureClass,
    attempt_count: attemptCount,
    safe_error: getRuntimeErrorDetails(error).message.slice(0, 500),
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
  const trustedNaturalScheduler = isCronAuthorized(request);
  if (!trustedNaturalScheduler) {
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
  let naturalShadow: Awaited<ReturnType<typeof runNaturalShadowObserverSafely>> = {
    status: "FAILED", reason: "NATURAL_SHADOW_NOT_NATURAL_SCHEDULER_PATH", warehousesEvaluated: 0,
  };
  let shadowComputeResult: ShadowComputeResult | null = null;
  const sync = await syncRillnet({
    checkpointAt,
    onSourceCoreComplete: !recovery && trustedNaturalScheduler
      ? async ({ syncRunId }) => {
          naturalShadow = await runNaturalShadowObserverSafely(client, { checkpointAt, syncRunId, trustedScheduler: true });
        }
      : undefined,
    onCheckpointHistoryPersisted: process.env.CHECKPOINT_PIPELINE_V2_SHADOW === "true"
      ? async ({ syncRunId, checkpointAt: cbCheckpointAt, orderCount, incidentCount, orders }) => {
          try {
            const queueRepo = RepositoryFactory.getCheckpointWorkQueueRepository(client);
            const shadowRunner = new CheckpointShadowRunner(queueRepo);
            shadowComputeResult = await shadowRunner.runShadowCompute({
              checkpointAt: cbCheckpointAt,
              syncRunId,
              orderCount,
              incidentCount,
              orders,
            });
          } catch (shadowErr) {
            logger.warn({
              category: "V2_SHADOW_ERROR",
              message: getRuntimeErrorDetails(shadowErr).message,
            });
          }
        }
      : undefined,
  });
  if (!sync.ok) {
    const status = sync.error?.code === "SYNC_ALREADY_RUNNING" ? 409 : 500;
    const auditPersisted = await writeCheckpointAudit({ checkpointAt, startedAt: sync.startedAt, completedAt: sync.completedAt, syncRunId: sync.syncRunId, executionStatus: "FAILED", httpStatus: status, errorCode: sync.error?.code, errorMessageSafe: sync.error?.message });
    if (!auditPersisted) {
      attention(checkpointAt, "SYNC", sync.error?.code || "SYNC_FAILURE", sync.syncLockAttempts || 1, sync.error?.message || "Sync failed");
    }
    if (recovery) {
      const retryable = isTransientInfrastructureError(sync.error);
      await finishCheckpointRecovery(client, checkpointAt, recovery.recoveryToken, {
        status: retryable ? "RETRYABLE" : "FAILED_REQUIRES_ATTENTION",
        failureStage: retryable ? "SYNC_RETRYABLE" : "CHECKPOINT_FAILED_REQUIRES_ATTENTION",
        lastSafeError: sync.error?.message || "Recovery sync failed",
      });
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
        attention(checkpointAt, "RECOVERY_QUEUE", "RECOVERY_QUEUE_FAILURE", 1, error);
      }
    }
    const v2Shadow = shadowComputeResult
      ? new CheckpointShadowRunner().finalizeParity(shadowComputeResult, null)
      : null;
    return NextResponse.json({ ok: false, stage: "SYNC", sync, v2Shadow }, { status });
  }

  if (sync.skipped && sync.skipReason === "CHECKPOINT_ALREADY_COMPLETED") {
    const auditPersisted = await writeCheckpointAudit({ checkpointAt, startedAt: sync.startedAt, completedAt: sync.completedAt, syncRunId: sync.syncRunId, executionStatus: "SUCCESS", httpStatus: 200, exclusionCounts: { CHECKPOINT_ALREADY_COMPLETED: 1 } });
    if (!auditPersisted) return failPrimaryAudit(client, checkpointAt, recovery, sync.syncRunId);
    await queuePhase2CheckpointWork(client, { checkpointAt, syncRunId: sync.syncRunId });
    if (recovery) await finishCheckpointRecovery(client, checkpointAt, recovery.recoveryToken, { status: "CONFIRMED", syncRunId: sync.syncRunId });
    return NextResponse.json({ ok: true, stage: "RECOVERY_ALREADY_COMPLETED", sync: { syncRunId: sync.syncRunId }, naturalShadow });
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
    const auditPersisted = await writeCheckpointAudit({
      checkpointAt, startedAt: sync.startedAt, completedAt: sync.completedAt, syncRunId: sync.syncRunId, executionStatus: "SUCCESS", httpStatus: 200,
      telegramScanned: 0, recipientsResolved: 0, interactionsCreated: 0, sendAttempts: 0, sendSuccess: 0, sendFailed: 0,
      statusUpdatesActive: statusUpdates?.active, statusUpdatesResolved: statusUpdates?.resolved,
      statusUpdateBatchesSent: statusUpdates?.sentBatches, statusUpdateBatchesFailed: statusUpdates?.failed,
      exclusionCounts: { NO_FRESH_EVIDENCE: 1 },
    });
    if (!auditPersisted) return failPrimaryAudit(client, checkpointAt, recovery, sync.syncRunId);
    if (recovery) await finishCheckpointRecovery(client, checkpointAt, recovery.recoveryToken, { status: "CONFIRMED", syncRunId: sync.syncRunId });
    return NextResponse.json({
      ok: rillnetReviews.failed === 0 && (!statusUpdates || statusUpdates.failed === 0),
      stage: "NO_FRESH_SNAPSHOT",
      sync,
      telegram: { scanned: 0, sent: 0, coveredCases: 0, skipped: 0, deferred: 0, failed: 0 },
      rillnetReviews,
      statusUpdates,
      errors: { rillnetReviewError, statusUpdateError },
      naturalShadow,
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
  // Phase 2 is durable separate work. It must never consume the primary HTTP budget.
  const auditPersisted = await writeCheckpointAudit({
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
  if (!auditPersisted) return failPrimaryAudit(client, checkpointAt, recovery, sync.syncRunId);
  await queuePhase2CheckpointWork(client, { checkpointAt, syncRunId: sync.syncRunId });
  if (recovery) await finishCheckpointRecovery(client, checkpointAt, recovery.recoveryToken, { status: "CONFIRMED", syncRunId: sync.syncRunId });

  // Pipeline V2 Shadow Runner: finalize parity report if V2 shadow compute ran
  let v2Shadow: ShadowParityReport | null = null;
  if (process.env.CHECKPOINT_PIPELINE_V2_SHADOW === "true") {
    try {
      const queueRepo = RepositoryFactory.getCheckpointWorkQueueRepository(client);
      const shadowRunner = new CheckpointShadowRunner(queueRepo);
      const v1Summary = {
        syncRunId: sync.syncRunId,
        checkpointAt,
        orderCount: sync.fetchedOrderCount || 0,
        incidentCount: sync.incidentCount || 0,
        caseCount: evaluation?.supportedCasesEvaluated || 0,
        memberCount: evaluation?.khoTonEvaluated || 0,
        decisionsCount: evaluation
          ? Object.values(evaluation.pendingCreated).reduce((sum, value) => sum + value, 0)
          : 0,
        interventionTypes: ["TELEGRAM_FIRST_PUSH", "TELEGRAM_FOLLOW_UP"],
      };

      if (shadowComputeResult) {
        v2Shadow = shadowRunner.finalizeParity(shadowComputeResult, v1Summary);
      } else {
        v2Shadow = await shadowRunner.runShadowComparison(v1Summary, []);
      }
    } catch (shadowErr) {
      logger.warn({
        category: "V2_SHADOW_ERROR",
        message: getRuntimeErrorDetails(shadowErr).message,
      });
    }
  }

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
    phase2: { status: "PENDING", syncRunId: sync.syncRunId },
    naturalShadow,
    v2Shadow,
  });
}

async function failPrimaryAudit(client: ReturnType<typeof createAdminClient>, checkpointAt: string, recovery: ReturnType<typeof recoveryRequest>, syncRunId?: string) {
  if (recovery) {
    await finishCheckpointRecovery(client, checkpointAt, recovery.recoveryToken, {
      status: "RETRYABLE", syncRunId, failureStage: "AUDIT_PERSISTENCE", lastSafeError: "Checkpoint audit persistence unconfirmed",
    });
  } else {
    try {
      await queueCheckpointRecovery(client, {
        checkpointAt, scheduledFor: new Date(Date.now() + 5 * 60_000).toISOString(),
        failureStage: "AUDIT_PERSISTENCE", lastSafeError: "Checkpoint audit persistence unconfirmed",
      });
    } catch (error) {
      attention(checkpointAt, "RECOVERY_QUEUE", "AUDIT_PERSISTENCE", 1, error);
    }
  }
  return NextResponse.json({ ok: false, stage: "AUDIT_PERSISTENCE", syncRunId }, { status: 503 });
}

export async function GET(request: NextRequest) {
  return runFollowupCycle(request);
}

export async function POST(request: NextRequest) {
  return runFollowupCycle(request);
}
