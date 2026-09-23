import type { ISyncService, SyncOptions, SyncSummary } from "../interfaces/ISyncService";
import type { ISyncRunRepository } from "@/repositories/interfaces/ISyncRunRepository";
import type { IOrderSnapshotRepository, OrderSnapshotRow } from "@/repositories/interfaces/IOrderSnapshotRepository";
import type { IInboundOrderObservationRepository, InboundOrderObservationRow } from "@/repositories/interfaces/IInboundOrderObservationRepository";
import type { IIncidentRepository } from "@/repositories/interfaces/IIncidentRepository";
import type { IIncidentHistoryRepository } from "@/repositories/interfaces/IIncidentHistoryRepository";
import type { IExceptionRepository } from "@/repositories/interfaces/IExceptionRepository";
import type { IFollowupRepository } from "@/repositories/interfaces/IFollowupRepository";
import type { IAiJobRepository } from "@/repositories/interfaces/IAiJobRepository";
import type { ISyncLockRepository } from "@/repositories/interfaces/ISyncLockRepository";
import type { ITriageAuditRepository } from "@/repositories/interfaces/ITriageAuditRepository";
import type { IPlaybookDirectiveRepository } from "@/repositories/interfaces/IPlaybookDirectiveRepository";
import type { PhaseTimingInfo, DetectedBottleneck } from "@/jobs/sync-rillnet";
import type { SyncPhase, SyncRunRow } from "@/connectors/supabase/types";
import { RillnetConnector } from "@/connectors/rillnet";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet";
import { aggregateIncidents, inspectOrderForIncident, REASON_CODE_MAP } from "@/engine/incident";
import { FollowupEngine } from "@/engine/followup";
import { ActionQueue } from "@/engine/action-queue";
import { refresh } from "@/projections/projection-engine";
import { logRuntimeError, logRuntimeMessage } from "@/observability/runtimeDiagnostics";
import { logger } from "@/observability/logger";
import { retryTelemetryFrom, retryTransientInfrastructure, type TransientRetryTelemetry } from "@/services/transient-infrastructure";
import { getRoutePromotion, routeIncident, shouldEnqueueAiJob, type TriageResult } from "@/engine/rules/triage";
import { hasConflictingActions, selectApplicablePlaybookDirectives } from "@/engine/rules/conflict-detector";
import warehouseAssignments from "@/data/warehouse-assignments.generated.json";
import { LaneObservationService } from "@/domain/lane-observation";
import type { LaneObservationRepository } from "@/domain/lane-observation";
import type { ISnapshotV3ShadowRepository } from "@/repositories/interfaces/ISnapshotV3ShadowRepository";
import { isSnapshotV3ShadowEnabled } from "@/config/snapshot-v3";
import { runSnapshotV3Shadow } from "@/services/snapshot-v3-shadow";

const INBOUND_OBSERVATION_SOURCE = "RILLNET" as const;

type WarehouseAssignment = { warehouseId: string; warehouseName: string; zone: string };
const warehouseZoneById = new Map((warehouseAssignments.warehouses as WarehouseAssignment[]).map((warehouse) => [warehouse.warehouseId, warehouse.zone]));
const warehouseZoneByName = new Map((warehouseAssignments.warehouses as WarehouseAssignment[]).map((warehouse) => [warehouse.warehouseName, warehouse.zone]));
// Matches the current warehouse-assignment catalogue. Deployment may override this
// with a comma-separated set through TRIAGE_PILOT_ZONES.
const TRIAGE_PILOT_ZONES = (process.env.TRIAGE_PILOT_ZONES || "Miền Bắc 3").split(",").map((value) => value.trim()).filter(Boolean);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPersistedUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function errorRecord(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as Record<string, unknown>;
  if (candidate.error && typeof candidate.error === "object") {
    return candidate.error as Record<string, unknown>;
  }
  return candidate;
}

function safeErrorCode(error: unknown): string {
  const record = errorRecord(error);
  if (typeof record?.code === "string" && record.code.trim()) return record.code;
  if (error instanceof Error && error.name.trim()) return error.name;
  return "SyncError";
}

function safeErrorMessage(error: unknown): string {
  const record = errorRecord(error);
  const structuredMessage = [record?.message, record?.details, record?.hint]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("; ");
  const message = error instanceof Error
    ? error.message
    : structuredMessage || (() => {
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    })();
  return message.replace(/https?:\/\/[^\s]+/g, "[URL REDACTED]").slice(0, 500);
}

/** Rillnet's snapshot metadata timestamp, never a local wall-clock substitute. */
function governedSourceFreshness(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) return null;
  return value;
}

/**
 * Establishes the governed per-run observation identity before any incident
 * selection happens. Rillnet supplies only a snapshot-level timestamp, not a
 * trustworthy per-order update timestamp, so conflicting duplicates cannot be
 * ordered safely and block population completion.
 */
export function buildCompleteInboundObservationPopulation(
  syncRunId: string,
  orders: NormalizedRillnetOrder[],
  sourceObservedAt: string
): {
  rows: InboundOrderObservationRow[];
  normalizedPopulationCount: number;
  duplicateIdenticalCount: number;
  duplicateConflictCount: number;
  duplicateConflictOrderCodes: string[];
} {
  const byOrderCode = new Map<string, InboundOrderObservationRow>();
  let duplicateIdenticalCount = 0;
  let duplicateConflictCount = 0;
  const duplicateConflictOrderCodes: string[] = [];

  for (const order of orders) {
    const row: InboundOrderObservationRow = {
      sync_run_id: syncRunId,
      source_system: INBOUND_OBSERVATION_SOURCE,
      order_code: String(order.orderCode || "").trim(),
      current_warehouse_id: order.warehouseId || null,
      deliver_warehouse_id: order.deliverWarehouseId || null,
      source_status: String(order.status || "").trim(),
      end_pick_at: order.endPickAt || null,
      weight_kg: order.weightKg ?? null,
      is_b2b: order.isB2b ?? null,
      source_observed_at: sourceObservedAt,
    };
    if (!row.order_code || !row.source_status) {
      throw new Error("INVALID_NORMALIZED_INBOUND_OBSERVATION");
    }

    const existing = byOrderCode.get(row.order_code);
    if (!existing) {
      byOrderCode.set(row.order_code, row);
      continue;
    }

    const equivalent = existing.current_warehouse_id === row.current_warehouse_id
      && existing.deliver_warehouse_id === row.deliver_warehouse_id
      && existing.source_status === row.source_status
      && existing.end_pick_at === row.end_pick_at
      && existing.weight_kg === row.weight_kg
      && existing.is_b2b === row.is_b2b;
    if (!equivalent) {
      duplicateConflictCount += 1;
      duplicateConflictOrderCodes.push(row.order_code);
      continue;
    }
    duplicateIdenticalCount += 1;
  }

  return {
    rows: [...byOrderCode.values()],
    normalizedPopulationCount: orders.length,
    duplicateIdenticalCount,
    duplicateConflictCount,
    duplicateConflictOrderCodes,
  };
}
export const ORDERED_SYNC_PHASES: SyncPhase[] = [
  "CREATED",
  "FETCHING_SNAPSHOT",
  "PERSISTING_SNAPSHOTS",
  "PERSISTING_INCIDENTS",
  "PERSISTING_HISTORY",
  "PROCESSING_FOLLOWUPS",
  "ENQUEUE_NOTIFICATIONS",
  "ENQUEUE_AI",
  "REFRESHING_PROJECTIONS",
  "COMPLETED",
];

export function getSafeResumePhase(
  requestedPhase: SyncPhase,
  stateAvailable: { snapshotInRam: boolean; incidentsRehydrated: boolean }
): { safePhase: SyncPhase; reason?: string } {
  if (requestedPhase === "CREATED" || requestedPhase === "FETCHING_SNAPSHOT") {
    return { safePhase: "FETCHING_SNAPSHOT" };
  }
  if (requestedPhase === "PERSISTING_SNAPSHOTS" || requestedPhase === "PERSISTING_INCIDENTS") {
    if (stateAvailable.snapshotInRam) {
      return { safePhase: requestedPhase };
    }
    return { safePhase: "FETCHING_SNAPSHOT", reason: "SNAPSHOT_DATA_NOT_IN_MEMORY" };
  }
  if (stateAvailable.incidentsRehydrated) {
    return { safePhase: requestedPhase };
  }
  if (stateAvailable.snapshotInRam) {
    return { safePhase: "PERSISTING_INCIDENTS", reason: "INCIDENT_STATE_NOT_REHYDRATABLE" };
  }
  return { safePhase: "FETCHING_SNAPSHOT", reason: "INCIDENT_STATE_NOT_REHYDRATABLE" };
}

/** The checkpoint audit consumes runtime Incident objects, which are camelCase. */
export function summarizeFollowupEvaluation(
  incidents: Array<{ reasonCode: string }>,
  followupResults: Array<{ newState: string; oldState?: string }>
) {
  return {
    supportedCasesEvaluated: incidents.filter((item) => ["KHO_TON", "KHO_CHU_A_LUAN_CHUYEN"].includes(item.reasonCode)).length,
    khoTonEvaluated: incidents.filter((item) => item.reasonCode === "KHO_TON").length,
    khoChuaLuanChuyenEvaluated: incidents.filter((item) => item.reasonCode === "KHO_CHU_A_LUAN_CHUYEN").length,
    pendingCreated: followupResults.reduce((counts: { first: number; second: number; third: number; escalation: number }, item) => {
      // A persisted pending state is not a newly created stage.  Keep
      // backwards compatibility for callers that do not provide oldState.
      if (item.oldState && item.oldState === item.newState) return counts;
      if (item.newState === "FIRST_PUSH_PENDING") counts.first++;
      if (item.newState === "SECOND_PUSH_PENDING") counts.second++;
      if (item.newState === "THIRD_PUSH_PENDING") counts.third++;
      if (item.newState === "ESCALATION_PENDING") counts.escalation++;
      return counts;
    }, { first: 0, second: 0, third: 0, escalation: 0 }),
  };
}

export class SyncService implements ISyncService {
  constructor(
    private syncRunRepo: ISyncRunRepository | null = null,
    private orderSnapshotRepo: IOrderSnapshotRepository | null = null,
    private incidentRepo: IIncidentRepository | null = null,
    private incidentHistoryRepo: IIncidentHistoryRepository | null = null,
    private exceptionRepo: IExceptionRepository | null = null,
    private followupRepo: IFollowupRepository | null = null,
    private aiJobRepo: IAiJobRepository | null = null,
    private actionQueue: ActionQueue | null = null,
    private syncLockRepo: ISyncLockRepository | null = null,
    private triageAuditRepo: ITriageAuditRepository | null = null,
    private playbookDirectiveRepo: IPlaybookDirectiveRepository | null = null,
    private laneObservationRepo: LaneObservationRepository | null = null,
    private inboundOrderObservationRepo: IInboundOrderObservationRepository | null = null,
    private snapshotV3ShadowRepo: ISnapshotV3ShadowRepository | null = null
  ) {}

  async runSync(_options?: SyncOptions): Promise<SyncSummary> {
    const startTime = Date.now();
    const startedAt = new Date(startTime).toISOString();

    const lockKey = "global:rillnet-sync";
    const ownerId = `owner_${startTime}_${Math.random().toString(36).substring(2, 9)}`;
    const ttlMs = parseInt(process.env.SYNC_LOCK_TTL_MS || "60000", 10);
    const heartbeatMs = parseInt(process.env.SYNC_LOCK_HEARTBEAT_MS || "15000", 10);

    let lockAcquired = false;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let syncLockTelemetry: TransientRetryTelemetry | null = null;
    let pendingSnapshotV3Shadow: { rows: OrderSnapshotRow[]; evaluationReferenceAt: string } | null = null;
    let resumeCheckpointRun = false;

    const identityUnavailable = (error: unknown): SyncSummary => ({
      ok: false,
      syncRunId: "",
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      fetchedOrderCount: 0,
      normalizedOrderCount: 0,
      incidentCount: 0,
      phaseTimings: {},
      dbInstrumentation: { totalQueries: 0, phases: {}, bottlenecksDetected: [] },
      error: { code: "CHECKPOINT_IDENTITY_UNAVAILABLE", message: safeErrorMessage(error) },
      syncLockAttempts: syncLockTelemetry?.attempts || 0,
      syncLockRetryCount: syncLockTelemetry?.retryCount || 0,
      syncLockFinalStatus: syncLockTelemetry?.finalStatus || "NOT_ATTEMPTED",
    });

    if (_options?.checkpointAt && this.syncRunRepo) {
      let existing: SyncRunRow | null;
      try {
        existing = (await retryTransientInfrastructure(() => this.syncRunRepo!.getSyncRunForCheckpoint(_options.checkpointAt!))).value;
      } catch (error) {
        logRuntimeError("SyncService.getSyncRunForCheckpoint", error);
        return identityUnavailable(error);
      }
      if (existing) {
        if (existing.status === "success" || existing.current_phase === "COMPLETED") {
          return { ok: true, skipped: true, skipReason: "CHECKPOINT_ALREADY_COMPLETED", syncRunId: existing.id, startedAt, completedAt: startedAt, durationMs: 0, fetchedOrderCount: existing.fetched_order_count, normalizedOrderCount: existing.normalized_order_count, incidentCount: existing.incident_count, phaseTimings: {}, dbInstrumentation: { totalQueries: 0, phases: {}, bottlenecksDetected: [] }, syncLockAttempts: 0, syncLockRetryCount: 0, syncLockFinalStatus: "NOT_ATTEMPTED" };
        }
        // The global sync lease below serializes recovery while retaining the
        // exact checkpoint run identity instead of creating a replacement.
        resumeCheckpointRun = true;
      }
    }

    if (!this.syncRunRepo) {
      return identityUnavailable(new Error("Persistent sync-run repository is unavailable."));
    }

    if (this.syncLockRepo) {
      let lockRes;
      try {
        const retried = await retryTransientInfrastructure(() => this.syncLockRepo!.acquireLock(lockKey, ownerId, ttlMs));
        lockRes = retried.value;
        syncLockTelemetry = retried.telemetry;
      } catch (err: any) {
        syncLockTelemetry = retryTelemetryFrom(err);
        logRuntimeError("SyncLock.acquireLock", err);
        return {
          ok: false,
          syncRunId: "",
          startedAt,
          completedAt: startedAt,
          durationMs: 0,
          fetchedOrderCount: 0,
          normalizedOrderCount: 0,
          incidentCount: 0,
          phaseTimings: {},
          dbInstrumentation: { totalQueries: 0, phases: {}, bottlenecksDetected: [] },
          error: {
            code: err?.code || err?.name || "LockAcquisitionError",
            message: err?.message || String(err),
          },
          syncLockAttempts: syncLockTelemetry?.attempts || 1,
          syncLockRetryCount: syncLockTelemetry?.retryCount || 0,
          syncLockFinalStatus: syncLockTelemetry?.finalStatus || "NON_RETRYABLE_FAILURE",
        };
      }

      if (!lockRes.acquired) {
        logger.info({
          component: "SyncService",
          operation: "acquireLock",
          status: "info",
          message: `[SyncLock] event=acquire status=contended lockKey=${lockKey}`
        });
        return {
          ok: false,
          syncRunId: "",
          startedAt,
          completedAt: startedAt,
          durationMs: 0,
          fetchedOrderCount: 0,
          normalizedOrderCount: 0,
          incidentCount: 0,
          phaseTimings: {},
          dbInstrumentation: {
            totalQueries: 0,
            phases: {},
            bottlenecksDetected: [],
          },
          error: {
            code: "SYNC_ALREADY_RUNNING",
            message: "A sync process is currently active and holding the distributed lock.",
          },
          syncLockAttempts: syncLockTelemetry?.attempts || 1,
          syncLockRetryCount: syncLockTelemetry?.retryCount || 0,
          syncLockFinalStatus: "SUCCESS",
        };
      }

      lockAcquired = true;
      logger.info({
        component: "SyncService",
        operation: "acquireLock",
        status: "info",
        message: `[SyncLock] event=acquire status=success lockKey=${lockKey}${
          lockRes.expiredTakeover ? " event=expired_takeover status=success" : ""
        }`
      });

      heartbeatTimer = setInterval(async () => {
        try {
          const renewed = await this.syncLockRepo!.renewLock(lockKey, ownerId, ttlMs);
          if (renewed) {
            logger.info({
              component: "SyncService",
              operation: "renewLock",
              status: "info",
              message: `[SyncLock] event=renew status=success lockKey=${lockKey}`
            });
          } else {
            logger.info({
              component: "SyncService",
              operation: "renewLock",
              status: "error",
              message: `[SyncLock] event=renew status=failed lockKey=${lockKey}`
            });
          }
        } catch (e: any) {
          logger.info({
            component: "SyncService",
            operation: "renewLock",
            status: "error",
            message: `[SyncLock] event=renew status=failed lockKey=${lockKey}`,
            metadata: { error: e?.message || String(e) }
          });
        }
      }, heartbeatMs);
    }

    try {
      const phaseTimings: Record<string, number> = {};
      const dbPhases: Record<string, PhaseTimingInfo> = {};
      let totalQueries = 0;
      const phaseStarts = new Map<string, { monotonicMs: number; startedAt: string }>();

      function logPhaseStart(name: string): void {
        const pStartedAt = new Date().toISOString();
        phaseStarts.set(name, { monotonicMs: performance.now(), startedAt: pStartedAt });
        logRuntimeMessage(`[SyncRuntime] phase=${name} event=start startedAt=${pStartedAt}`);
      }

      function logPhaseEnd(name: string, rowCount: number, status: "success" | "failed" = "success"): void {
        const start = phaseStarts.get(name);
        const finishedAt = new Date().toISOString();
        const durationMs = start ? Math.max(0, Math.round((performance.now() - start.monotonicMs) * 100) / 100) : 0;
        logRuntimeMessage(
          `[SyncRuntime] phase=${name} event=end startedAt=${start?.startedAt || "unknown"} finishedAt=${finishedAt} durationMs=${durationMs} rowCount=${rowCount} status=${status}`
        );
      }

      function recordPhase(
        name: string,
        durationMs: number,
        rowsProcessed: number = 0,
        batchCount: number = 0,
        batchSize: number = 0,
        queryCount: number = 0,
        details?: string
      ) {
        const roundedDuration = Math.max(0, Math.round(durationMs * 100) / 100);
        phaseTimings[name] = roundedDuration;
        totalQueries += queryCount;

        dbPhases[name] = {
          durationMs: roundedDuration,
          rowsProcessed,
          batchCount,
          batchSize,
          queryCount,
          details,
        };

        logPhaseEnd(name, rowsProcessed);
        logger.info({
          component: "SyncService",
          operation: "performanceInstrumentation",
          status: "info",
          message: `[SyncRillnet Performance Instrumentation] Phase: ${name} | Duration: ${roundedDuration}ms | Queries: ${queryCount} | Rows: ${rowsProcessed} | Batches: ${batchCount} (size: ${batchSize})${
            details ? ` | Note: ${details}` : ""
          }`
        });
      }

      const bottlenecksDetected: DetectedBottleneck[] = [
        {
          category: "DB_AWAITS_INSIDE_LOOP",
          description:
            "FollowupEngine now batches case upserts and event inserts; remaining persistence work is bounded by active and disappeared case/event batches.",
          fileAndLine: "src/engine/followup/followup-engine.ts:149, 231",
        },
        {
          category: "SEQUENTIAL_ACTION_ENQUEUE",
          description:
            "ActionQueue.enqueueAction() executes sequential deduplication lookups, action inserts, and audit event inserts per incident inside the loop.",
          fileAndLine: "src/engine/followup/followup-engine.ts:171",
        },
        {
          category: "REPEATED_DB_QUERY",
          description:
            "FollowupEngine executes getAllCases() to query all cases again after already fetching cases by active incident keys earlier in the method.",
          fileAndLine: "src/engine/followup/followup-engine.ts:202",
        },
      ];

      // State placeholders across phases
      let fetchedOrderCount = 0;
      let normalizedOrderCount = 0;
      let incidentCount = 0;
      let resolvedIncidentCount = 0;
      let sourceUpdatedAt: string | null = null;
      let snapshotResult: any = { orders: [], totalOrders: 0, fetchedAt: startedAt };
      let activeExceptions = new Set<string>();
      let incidents: any[] = [];
      const keyToIdMap = new Map<string, string>();
      let reusingCompleteInboundPopulation = false;
      let completePopulationResumeReady = false;
      let completePopulationPersistedCount = 0;

      // 1. Resume Check & State Rehydration
      let syncRunId = "";
      let completedPhases: SyncPhase[] = [];

      try {
          const unfinishedRun: SyncRunRow | null = (await retryTransientInfrastructure(() =>
            resumeCheckpointRun
              ? this.syncRunRepo!.getSyncRunForCheckpoint(_options!.checkpointAt!)
              : this.syncRunRepo!.getUnfinishedSyncRun()
          )).value;
          if (resumeCheckpointRun && !unfinishedRun) {
            throw new Error("CHECKPOINT_RUN_MISSING_AFTER_LOCK");
          }
          if (resumeCheckpointRun && unfinishedRun && (unfinishedRun.status === "success" || unfinishedRun.current_phase === "COMPLETED")) {
            return { ok: true, skipped: true, skipReason: "CHECKPOINT_ALREADY_COMPLETED", syncRunId: unfinishedRun.id, startedAt, completedAt: startedAt, durationMs: 0, fetchedOrderCount: unfinishedRun.fetched_order_count, normalizedOrderCount: unfinishedRun.normalized_order_count, incidentCount: unfinishedRun.incident_count, phaseTimings: {}, dbInstrumentation: { totalQueries: 0, phases: {}, bottlenecksDetected: [] }, syncLockAttempts: 0, syncLockRetryCount: 0, syncLockFinalStatus: "NOT_ATTEMPTED" };
          }
          if (unfinishedRun) {
            if (!isPersistedUuid(unfinishedRun.id)) {
              throw new Error("Persistent sync run returned a non-UUID identity.");
            }
            syncRunId = unfinishedRun.id;
            completedPhases = Array.isArray(unfinishedRun.completed_phases) ? [...unfinishedRun.completed_phases] : ["CREATED"];

            const requestedResume = ORDERED_SYNC_PHASES.find((p) => !completedPhases.includes(p)) || "COMPLETED";

            // Try rehydrating incidents from DB for this sync_run_id
            let incidentsRehydrated = false;
            if (this.incidentRepo) {
              try {
                const persistedRows = await this.incidentRepo.getIncidentsBySyncRunId(syncRunId);
                if (persistedRows && persistedRows.length > 0) {
                  incidents = persistedRows.map((row) => ({
                    incidentId: row.id,
                    incidentKey: row.incident_key,
                    warehouseId: row.warehouse_id,
                    warehouseName: row.warehouse_name || "",
                    reasonCode: row.reason_code,
                    reasonName: row.reason_name || "",
                    status: row.status,
                    priorityScore: row.priority_score,
                    firstDetectedAt: row.first_detected_at,
                    lastDetectedAt: row.last_detected_at,
                    affectedOrderCount: 0,
                    sampleOrderCodes: [],
                    averageAgeHours: 0,
                    maximumAgeHours: 0,
                  }));
                  incidentCount = incidents.length;
                  for (const row of persistedRows) {
                    keyToIdMap.set(row.incident_key, row.id);
                  }
                  incidentsRehydrated = true;
                }
              } catch {
                incidentsRehydrated = false;
              }
            }

            if (this.inboundOrderObservationRepo) {
              const manifest = await this.inboundOrderObservationRepo.getPopulationManifest(
                syncRunId,
                INBOUND_OBSERVATION_SOURCE,
              );
              if (manifest?.population_status === "COMPLETE") {
                const persistedCount = await this.inboundOrderObservationRepo.countPersisted(
                  syncRunId,
                  INBOUND_OBSERVATION_SOURCE,
                );
                if (
                  persistedCount !== manifest.expected_observation_count
                  || persistedCount !== manifest.persisted_observation_count
                  || manifest.duplicate_conflict_count !== 0
                ) {
                  throw new Error(
                    `INBOUND_COMPLETE_POPULATION_COUNT_MISMATCH: expected=${manifest.expected_observation_count}, manifest=${manifest.persisted_observation_count}, found=${persistedCount}`,
                  );
                }

                reusingCompleteInboundPopulation = true;
                completePopulationPersistedCount = persistedCount;
                normalizedOrderCount = manifest.normalized_population_count;
                fetchedOrderCount = unfinishedRun.fetched_order_count || manifest.normalized_population_count;
                sourceUpdatedAt = manifest.source_freshness || unfinishedRun.source_updated_at || null;
                const requiredCompletedPhases: SyncPhase[] = [
                  "FETCHING_SNAPSHOT",
                  "PERSISTING_SNAPSHOTS",
                  "PERSISTING_INCIDENTS",
                  "PERSISTING_HISTORY",
                ];
                completePopulationResumeReady = incidentsRehydrated
                  && requiredCompletedPhases.every((phase) => completedPhases.includes(phase));
              }
            }

            const snapshotInRam = Array.isArray(snapshotResult.orders) && snapshotResult.orders.length > 0;
            const { safePhase, reason } = getSafeResumePhase(requestedResume, { snapshotInRam, incidentsRehydrated });

            if (reason) {
              logger.info({
              component: "SyncService",
              operation: "syncRecovery",
              status: "info",
              message: `[SyncRecovery] syncRun=${syncRunId} requestedResume=${requestedResume} safeResume=${safePhase} reason=${reason}`
            });
            } else {
              logger.info({
              component: "SyncService",
              operation: "syncResume",
              status: "info",
              message: `[SyncResume] syncRun=${syncRunId} resumeFrom=${safePhase}`
            });
            logger.info({
              component: "SyncService",
              operation: "syncRecovery",
              status: "info",
              message: `[SyncRecovery] previousRunRecovered=true completedPhases=${completedPhases.length}`
            });
            }

            // Truncate completedPhases to only include phases strictly prior to safePhase
            const safeIdx = ORDERED_SYNC_PHASES.indexOf(safePhase);
            completedPhases = ORDERED_SYNC_PHASES.slice(0, safeIdx);
          } else {
            const newRunId = crypto.randomUUID();
            const newRun = (await retryTransientInfrastructure(
              () => this.syncRunRepo!.createSyncRun(startedAt, { id: newRunId, checkpointAt: _options?.checkpointAt })
            )).value;
            if (!isPersistedUuid(newRun.id)) {
              throw new Error("Persistent sync run creation returned a non-UUID identity.");
            }
            syncRunId = newRun.id;
            completedPhases = ["CREATED"];
            logger.info({
              component: "SyncService",
              operation: "phaseCreated",
              status: "info",
              message: `[SyncPhase] phase=CREATED status=completed durationMs=0`
            });
          }
      } catch (error) {
        logRuntimeError("SyncService.acquireCheckpointIdentity", error);
        return identityUnavailable(error);
      }

      const checkpointPhase = async (phase: SyncPhase) => {
        if (!completedPhases.includes(phase)) {
          completedPhases.push(phase);
          if (this.syncRunRepo) {
            await retryTransientInfrastructure(() => this.syncRunRepo!.updatePhase(syncRunId, phase, completedPhases));
          }
        }
      };

      const notifySourceCoreComplete = async (populationCompletedAt: string, sourceFreshness: string | null) => {
        if (!_options?.onSourceCoreComplete || !sourceFreshness) return;
        try {
          await _options.onSourceCoreComplete({
            syncRunId,
            checkpointAt: _options.checkpointAt,
            sourceFreshness,
            populationCompletedAt,
          });
        } catch (error) {
          // Shadow observation is intentionally isolated from the legacy sync.
          logger.info({ component: "SyncService", operation: "sourceCoreObserver", status: "error", message: "Source-core observer failed without blocking sync.", metadata: { error: safeErrorMessage(error) } });
        }
      };

      try {
        if (reusingCompleteInboundPopulation && !completePopulationResumeReady) {
          throw new Error("INBOUND_COMPLETE_POPULATION_RESUME_STATE_UNAVAILABLE");
        }

        // Phase 2: FETCHING_SNAPSHOT
        const pFetch = "FETCHING_SNAPSHOT" as SyncPhase;
        if (reusingCompleteInboundPopulation) {
          logger.info({
            component: "SyncService",
            operation: "inboundPopulation",
            status: "info",
            message: `[SyncResume] inboundPopulation=COMPLETE_REUSED rows=${completePopulationPersistedCount}`,
            metadata: { syncRunId, persistedCount: completePopulationPersistedCount },
          });
        } else if (completedPhases.includes(pFetch) && snapshotResult.orders && snapshotResult.orders.length > 0) {
          logger.info({
              component: "SyncService",
              operation: "phaseFetch",
              status: "info",
              message: `[SyncPhase] phase=${pFetch} status=skipped durationMs=0`
            });
        } else {
          const tFetchStart = performance.now();
          logPhaseStart("fetchSnapshot");
          const connector = new RillnetConnector();

          const tUrlStart = performance.now();
          logPhaseStart("fetchSnapshotUrlOnly");
          const { downloadUrl, updatedAt } = await connector.fetchSnapshotUrlOnly();
          logPhaseEnd("fetchSnapshotUrlOnly", 1);
          const fetchUrlDuration = performance.now() - tUrlStart;

          const previousSuccessfulRun = await this.syncRunRepo!.getPreviousSuccessfulSyncRun(syncRunId);
          const previousSourceTime = previousSuccessfulRun?.source_updated_at
            ? new Date(previousSuccessfulRun.source_updated_at).getTime()
            : Number.NaN;
          const currentSourceTime = updatedAt ? new Date(updatedAt).getTime() : Number.NaN;

          if (
            previousSuccessfulRun &&
            !_options?.forceReprocessSource &&
            Number.isFinite(previousSourceTime) &&
            Number.isFinite(currentSourceTime) &&
            previousSourceTime === currentSourceTime
          ) {
            sourceUpdatedAt = updatedAt;
            fetchedOrderCount = previousSuccessfulRun.fetched_order_count;
            normalizedOrderCount = previousSuccessfulRun.normalized_order_count;
            incidentCount = previousSuccessfulRun.incident_count;
            const completedAt = new Date().toISOString();
            const durationMs = Date.now() - startTime;
            const completedPhasesForNoop = [...ORDERED_SYNC_PHASES];

            phaseTimings.fetchSnapshotUrlOnly = Math.max(
              0,
              Math.round(fetchUrlDuration * 100) / 100
            );
            if (this.syncRunRepo) {
              await retryTransientInfrastructure(() => this.syncRunRepo!.updateSuccess(syncRunId, {
                completedAt,
                fetchedOrderCount,
                normalizedOrderCount,
                incidentCount,
                durationMs,
                sourceUpdatedAt,
              }));
              await retryTransientInfrastructure(() => this.syncRunRepo!.updatePhase(
                syncRunId,
                "COMPLETED",
                completedPhasesForNoop
              ));
            }

            logger.info({
              component: "SyncService",
              operation: "skipUnchangedSource",
              status: "success",
              message: `[SyncPhase] phase=COMPLETED status=skipped reason=SOURCE_UNCHANGED durationMs=${durationMs}`,
            });

            return {
              ok: true,
              skipped: true,
              skipReason: "SOURCE_UNCHANGED",
              syncRunId,
              startedAt,
              completedAt,
              durationMs,
              fetchedOrderCount,
              normalizedOrderCount,
              incidentCount,
              resolvedIncidentCount: 0,
              phaseTimings,
              dbInstrumentation: {
                totalQueries,
                phases: dbPhases,
                bottlenecksDetected,
              },
              syncLockAttempts: syncLockTelemetry?.attempts || 0,
              syncLockRetryCount: syncLockTelemetry?.retryCount || 0,
              syncLockFinalStatus: syncLockTelemetry?.finalStatus || "NOT_ATTEMPTED",
            };
          }

          const tDownloadStart = performance.now();
          logPhaseStart("downloadSnapshot");
          const buffer = await connector.downloadBufferOnly(downloadUrl);
          logPhaseEnd("downloadSnapshot", buffer.byteLength);
          const downloadDuration = performance.now() - tDownloadStart;

          const tParseStart = performance.now();
          logPhaseStart("parseSnapshot");
          snapshotResult = await connector.parseSnapshotFromBuffer(buffer, updatedAt);
          logPhaseEnd("parseSnapshot", snapshotResult.totalOrders);
          const parseDuration = performance.now() - tParseStart;

          const fetchTotalDuration = performance.now() - tFetchStart;
          fetchedOrderCount = snapshotResult.totalOrders;
          normalizedOrderCount = snapshotResult.orders.length;
          sourceUpdatedAt = snapshotResult.fetchedAt;

          recordPhase(
            "fetchSnapshot",
            fetchTotalDuration,
            fetchedOrderCount,
            1,
            fetchedOrderCount,
            0,
            `API request: ${Math.round(fetchUrlDuration)}ms, Download: ${Math.round(downloadDuration)}ms, Decompress/Parse: ${Math.round(parseDuration)}ms`
          );

          await checkpointPhase(pFetch);
          logger.info({
              component: "SyncService",
              operation: "phaseFetch",
              status: "info",
              message: `[SyncPhase] phase=${pFetch} status=completed durationMs=${Math.round(fetchTotalDuration)}`
            });
        }

        // A COMPLETE population is immutable. A resumed process with persisted
        // downstream state reuses its manifest and rows without refetching,
        // normalizing, replacing, or reinserting source data.
        const manifestSourceFreshness = governedSourceFreshness(sourceUpdatedAt);
        if (!reusingCompleteInboundPopulation && (!snapshotResult.orders || snapshotResult.orders.length === 0)) {
          if (!this.inboundOrderObservationRepo) {
            // In-memory legacy runs retain their existing behavior but cannot
            // become inbound-evidence authoritative: no manifest exists.
            logger.info({ component: "SyncService", operation: "inboundPopulation", status: "info", message: "Inbound population repository unavailable; run is not evidence-authoritative." });
          } else {
            const emptyManifest = {
            sync_run_id: syncRunId,
            source_system: INBOUND_OBSERVATION_SOURCE,
            normalized_population_count: 0,
            expected_observation_count: 0,
            duplicate_identical_count: 0,
            duplicate_conflict_count: 0,
            source_freshness: manifestSourceFreshness,
          };
            try {
              await this.inboundOrderObservationRepo.replaceIncompletePopulation(emptyManifest);
              const persistedCount = await this.inboundOrderObservationRepo.countPersisted(syncRunId, INBOUND_OBSERVATION_SOURCE);
              if (persistedCount !== 0) throw new Error(`INBOUND_POPULATION_COUNT_MISMATCH: expected 0, found ${persistedCount}`);
              const populationCompletedAt = new Date().toISOString();
              await this.inboundOrderObservationRepo.completePopulation({
                ...emptyManifest,
                persisted_observation_count: 0,
                population_completed_at: populationCompletedAt,
              });
              await notifySourceCoreComplete(populationCompletedAt, manifestSourceFreshness);
            } catch (error) {
              const reason = safeErrorMessage(error);
              await this.inboundOrderObservationRepo.failPopulation({ sync_run_id: syncRunId, source_system: INBOUND_OBSERVATION_SOURCE, failure_reason: reason });
              throw error;
            }
          }
        }

        // Re-normalize and load exceptions if snapshot is available
        if (!reusingCompleteInboundPopulation && snapshotResult.orders && snapshotResult.orders.length > 0) {
          const tNormStart = performance.now();
          logPhaseStart("normalizeOrders");
          normalizedOrderCount = snapshotResult.orders.length;
          recordPhase("normalizeOrders", performance.now() - tNormStart, normalizedOrderCount, 1, normalizedOrderCount, 0, "Mapped raw orders to normalized objects");

          // This is the inbound-evidence authority boundary. It intentionally
          // precedes exception handling, aggregateIncidents, and every
          // inspectOrderForIncident call so incident selection cannot affect
          // the complete normalized population.
          if (!this.inboundOrderObservationRepo) {
            logger.info({ component: "SyncService", operation: "inboundPopulation", status: "info", message: "Inbound population repository unavailable; run is not evidence-authoritative." });
          } else {
            const observedAt = sourceUpdatedAt || snapshotResult.fetchedAt || startedAt;
            let population;
            try {
              population = buildCompleteInboundObservationPopulation(syncRunId, snapshotResult.orders, observedAt);
            const manifestInput = {
              sync_run_id: syncRunId,
              source_system: INBOUND_OBSERVATION_SOURCE,
              normalized_population_count: population.normalizedPopulationCount,
              expected_observation_count: population.rows.length,
              duplicate_identical_count: population.duplicateIdenticalCount,
              duplicate_conflict_count: population.duplicateConflictCount,
              source_freshness: manifestSourceFreshness,
            };
            await this.inboundOrderObservationRepo.replaceIncompletePopulation(manifestInput);
            if (population.duplicateConflictCount > 0) {
              throw new Error(`DUPLICATE_INBOUND_ORDER_CONFLICT:${population.duplicateConflictOrderCodes.join(",")}`);
            }
            await this.inboundOrderObservationRepo.insertBatch(population.rows, 500);
            const persistedCount = await this.inboundOrderObservationRepo.countPersisted(syncRunId, INBOUND_OBSERVATION_SOURCE);
            if (persistedCount !== manifestInput.expected_observation_count) {
              throw new Error(`INBOUND_POPULATION_COUNT_MISMATCH: expected ${manifestInput.expected_observation_count}, found ${persistedCount}`);
            }
              const populationCompletedAt = new Date().toISOString();
              await this.inboundOrderObservationRepo.completePopulation({
                ...manifestInput,
                persisted_observation_count: persistedCount,
                population_completed_at: populationCompletedAt,
              });
              await notifySourceCoreComplete(populationCompletedAt, manifestSourceFreshness);
            } catch (error) {
              const reason = safeErrorMessage(error);
              try {
                await this.inboundOrderObservationRepo.failPopulation({
                  sync_run_id: syncRunId,
                  source_system: INBOUND_OBSERVATION_SOURCE,
                  failure_reason: reason,
                });
              } catch (manifestError) {
                throw new Error(`INBOUND_POPULATION_FAILURE_UNRECORDED: ${reason}; ${safeErrorMessage(manifestError)}`);
              }
              throw error;
            }
          }

          const tExStart = performance.now();
          logPhaseStart("loadExceptions");
          let exQueries = 0;
          if (this.exceptionRepo) {
            try {
              activeExceptions = await this.exceptionRepo.getActiveExceptionOrderCodes(startedAt);
              exQueries = 1;
            } catch {
              // Fallback
            }
          }
          recordPhase("loadExceptions", performance.now() - tExStart, activeExceptions.size, exQueries, activeExceptions.size, exQueries, "Active order exceptions lookup");

          // Build Incidents in memory if not already rehydrated
          if (incidents.length === 0) {
            const referenceTimeMs = _options?.referenceTimeMs || (sourceUpdatedAt ? new Date(sourceUpdatedAt).getTime() : startTime);
            incidents = aggregateIncidents(snapshotResult.orders || [], undefined, referenceTimeMs, activeExceptions);
            incidentCount = incidents.length;
          }
        }

        // Phase 3: PERSISTING_SNAPSHOTS
        const pSnap = "PERSISTING_SNAPSHOTS" as SyncPhase;
        if (completedPhases.includes(pSnap)) {
          logger.info({
              component: "SyncService",
              operation: "phaseSnapshot",
              status: "info",
              message: `[SyncPhase] phase=${pSnap} status=skipped durationMs=0`
            });
        } else {
          const tSnapStart = performance.now();
          logPhaseStart("persistSnapshots");
          let snapQueries = 0;
          let snapRowsProcessed = 0;
          let snapBatches = 0;

          if (this.orderSnapshotRepo && snapshotResult.orders) {
            try {
              const referenceTimeMs = _options?.referenceTimeMs || (sourceUpdatedAt ? new Date(sourceUpdatedAt).getTime() : startTime);
              const snapshotRows: OrderSnapshotRow[] = [];
              for (const o of snapshotResult.orders) {
                const orderCode = (o.orderCode || o.id).trim();
                if (activeExceptions.has(orderCode)) continue;

                const match = inspectOrderForIncident(o, undefined, referenceTimeMs);
                if (!match) continue;

                const reasonMeta = REASON_CODE_MAP[match.reason];
                snapshotRows.push({
                  sync_run_id: syncRunId,
                  order_code: orderCode,
                  warehouse_id: o.warehouseId || undefined,
                  warehouse_name: o.warehouseName || undefined,
                  source_status: o.status,
                  task_category: o.taskCategory || undefined,
                  reason_code: reasonMeta ? reasonMeta.code : undefined,
                  order_created_at: o.createdAt || undefined,
                  source_updated_at: sourceUpdatedAt || undefined,
                  age_hours: match.ageHours ? Math.round(match.ageHours * 10) / 10 : undefined,
                  pick_warehouse_id: o.pickWarehouseId,
                  deliver_warehouse_id: o.deliverWarehouseId,
                  deliver_warehouse_name: o.deliverWarehouseName,
                  destination_province_id: o.destinationProvinceId,
                  destination_district_id: o.destinationDistrictId,
                  weight_grams: o.weightGrams,
                  weight_kg: o.weightKg,
                  sort_code: o.sortCode,
                  is_b2b: o.isB2b,
                  service_type_id: o.serviceTypeId,
                  end_pick_at: o.endPickAt,
                  end_delivery_at: o.endDeliveryAt,
                  end_success_at: o.endSuccessAt,
                  warehouse_log: o.warehouseLog || [],
                });
              }

              snapRowsProcessed = snapshotRows.length;
              snapBatches = Math.ceil(snapshotRows.length / 500);
              snapQueries = snapBatches;

              const legacyRows = await this.orderSnapshotRepo.insertBatch(snapshotRows, 500);
              snapRowsProcessed = legacyRows;
              if (isSnapshotV3ShadowEnabled()) {
                // Defer V3 writes until the sync reaches COMPLETED so a
                // failed/partial run cannot become a reconstructable cohort.
                pendingSnapshotV3Shadow = {
                  rows: snapshotRows,
                  evaluationReferenceAt: new Date(referenceTimeMs).toISOString(),
                };
              }
            } catch {
              // Fallback
            }
          }
          // Passive observation inspects the full normalized population and is
          // intentionally independent from incident-selected order_snapshots.
          if (this.laneObservationRepo && snapshotResult.orders) {
            try {
              await new LaneObservationService(this.laneObservationRepo).observe(
                syncRunId,
                sourceUpdatedAt || snapshotResult.fetchedAt || startedAt,
                snapshotResult.orders
              );
            } catch (error) {
              logger.info({ component: "SyncService", operation: "laneObservation", status: "error", message: "Passive lane observation failed without blocking Rillnet-first sync.", metadata: { error: error instanceof Error ? error.message : String(error) } });
            }
          }
          const snapDuration = performance.now() - tSnapStart;
          recordPhase("persistSnapshots", snapDuration, snapRowsProcessed, snapBatches, 500, snapQueries, "Batched order_snapshots insertion");
          await checkpointPhase(pSnap);
          logger.info({
              component: "SyncService",
              operation: "phaseSnapshot",
              status: "info",
              message: `[SyncPhase] phase=${pSnap} status=completed durationMs=${Math.round(snapDuration)}`
            });
        }

        // Phase 4: PERSISTING_INCIDENTS
        const pInc = "PERSISTING_INCIDENTS" as SyncPhase;
        if (completedPhases.includes(pInc) && incidents.length > 0) {
          logger.info({
              component: "SyncService",
              operation: "phaseIncidents",
              status: "info",
              message: `[SyncPhase] phase=${pInc} status=skipped durationMs=0`
            });
        } else {
          const tUpsertIncStart = performance.now();
          logPhaseStart("persistIncidents");
          let incQueries = 0;

          if (incidents.length > 0) {
            if (!this.incidentRepo) throw new Error("Persistent incident repository is unavailable.");
            const savedIncidentRows = (await retryTransientInfrastructure(
              () => this.incidentRepo!.upsertIncidents(incidents, syncRunId)
            )).value;
            incQueries = 1;
            for (const row of savedIncidentRows) {
              if (!isPersistedUuid(row.id)) {
                throw new Error(`Persisted incident ${row.incident_key} returned a non-UUID identity.`);
              }
              keyToIdMap.set(row.incident_key, row.id);
            }
          }
          const incDuration = performance.now() - tUpsertIncStart;
          recordPhase("persistIncidents", incDuration, incidents.length, 1, incidents.length, incQueries, "Upserted active incidents into DB");
          await checkpointPhase(pInc);
          logger.info({
              component: "SyncService",
              operation: "phaseIncidents",
              status: "info",
              message: `[SyncPhase] phase=${pInc} status=completed durationMs=${Math.round(incDuration)}`
            });
        }

        // Composite incident keys are business identifiers only. UUID foreign-key
        // writes must use the durable ID returned by the incidents upsert.
        for (const incident of incidents) {
          const persistedId = keyToIdMap.get(incident.incidentKey);
          if (!isPersistedUuid(persistedId)) {
            throw new Error(`PERSISTED_INCIDENT_IDENTITY_UNAVAILABLE:${incident.incidentKey}`);
          }
          incident.incidentId = persistedId;
        }

        // Phase 5: PERSISTING_HISTORY
        const pHist = "PERSISTING_HISTORY" as SyncPhase;
        if (completedPhases.includes(pHist)) {
          logger.info({
              component: "SyncService",
              operation: "phaseHistory",
              status: "info",
              message: `[SyncPhase] phase=${pHist} status=skipped durationMs=0`
            });
        } else {
          const tHistStart = performance.now();
          logPhaseStart("persistHistory");
          let histQueries = 0;

          if (this.incidentHistoryRepo && incidents.length > 0) {
            try {
              await this.incidentHistoryRepo.insertHistoryRecords(keyToIdMap, incidents, syncRunId, startedAt);
              histQueries = 1;
            } catch {
              // Fallback
            }
          }
          const histDuration = performance.now() - tHistStart;
          recordPhase("persistHistory", histDuration, incidents.length, 1, incidents.length, histQueries, "Inserted incident_history snapshot rows");

          if (this.incidentRepo) {
            try {
              const activeKeys = incidents.map((inc) => inc.incidentKey);
              resolvedIncidentCount = await this.incidentRepo.resolveAbsentIncidents(activeKeys, syncRunId, startedAt);
            } catch {
              // Fallback
            }
          }
          await checkpointPhase(pHist);
          logger.info({
              component: "SyncService",
              operation: "phaseHistory",
              status: "info",
              message: `[SyncPhase] phase=${pHist} status=completed durationMs=${Math.round(histDuration)}`
            });
        }

        // Load incident histories for follow-up evaluation
        let historyMap = new Map();
        const incidentDbIds: string[] = [];
        if (this.incidentHistoryRepo && incidents.length > 0) {
          try {
            for (const inc of incidents) {
              const dbId = keyToIdMap.get(inc.incidentKey);
              if (isPersistedUuid(dbId)) incidentDbIds.push(dbId);
            }
            if (incidentDbIds.length > 0) {
              historyMap = await this.incidentHistoryRepo.getHistoriesByIncidentIds(incidentDbIds);
            }
          } catch {
            // Fallback
          }
        }

        // Phase 6: PROCESSING_FOLLOWUPS
        const pFol = "PROCESSING_FOLLOWUPS" as SyncPhase;
        let followupResults: any[] = [];

        if (completedPhases.includes(pFol)) {
          logger.info({
              component: "SyncService",
              operation: "phaseFollowup",
              status: "info",
              message: `[SyncPhase] phase=${pFol} status=skipped durationMs=0`
            });
        } else {
          const tFollowupStart = performance.now();
          logPhaseStart("processFollowups");
          let followupQueries = 0;

          if (this.followupRepo) {
            const referenceTimeMs = _options?.referenceTimeMs || startTime;
            const actQueue = this.actionQueue || new ActionQueue(null);
            const followupEngine = new FollowupEngine(this.followupRepo, actQueue);
            followupResults = await followupEngine.processIncidentFollowups(incidents, historyMap, undefined, referenceTimeMs, snapshotResult.orders);
            const followupMetrics = followupEngine.getLastRunMetrics();
            followupQueries = followupMetrics ? followupMetrics.caseReads + followupMetrics.caseWrites + followupMetrics.eventWrites : 0;
          }

          const folDuration = performance.now() - tFollowupStart;
          recordPhase("processFollowups", folDuration, incidents.length, 1, incidents.length, followupQueries, "Deterministic Follow-up state machine evaluation");
          await checkpointPhase(pFol);
          logger.info({
              component: "SyncService",
              operation: "phaseFollowup",
              status: "info",
              message: `[SyncPhase] phase=${pFol} status=completed durationMs=${Math.round(folDuration)}`
            });
        }

        // Phase 7: ENQUEUE_NOTIFICATIONS
        const pNotif = "ENQUEUE_NOTIFICATIONS" as SyncPhase;
        if (completedPhases.includes(pNotif)) {
          logger.info({
              component: "SyncService",
              operation: "phaseNotifications",
              status: "info",
              message: `[SyncPhase] phase=${pNotif} status=skipped durationMs=0`
            });
        } else {
          const tEnqueueStart = performance.now();
          logPhaseStart("enqueueActions");
          const enqueuedCount = followupResults.filter((r) => r.newState && r.newState.includes("PENDING")).length;
          recordPhase("enqueueActions", performance.now() - tEnqueueStart, enqueuedCount, enqueuedCount, 1, 0, "ActionQueue notification action enqueueing");
          await checkpointPhase(pNotif);
          logger.info({
              component: "SyncService",
              operation: "phaseNotifications",
              status: "info",
              message: `[SyncPhase] phase=${pNotif} status=completed durationMs=0`
            });
        }

        // Phase 8: ENQUEUE_AI
        const pAi = "ENQUEUE_AI" as SyncPhase;
        if (completedPhases.includes(pAi)) {
          logger.info({
              component: "SyncService",
              operation: "phaseAI",
               status: "info",
              message: `[SyncPhase] phase=${pAi} status=skipped durationMs=0`
            });
        } else {
          const tAiStart = performance.now();
          logPhaseStart("enqueueAiJobs");
          let successfulEnqueue = 0;

          const followupStateByIncidentId = new Map(followupResults.map((item) => [item.incidentId, item.newState]));
          const triageByIncidentId = new Map<string, TriageResult>();
          // Directives are human-approved configuration, not observations from Rillnet
          // and not content inferred by an AI model. An unavailable registry fails
          // closed: it cannot manufacture a conflict or interrupt Lane A follow-up.
          let activeDirectives: Awaited<ReturnType<IPlaybookDirectiveRepository["getActiveDirectives"]>> = [];
          if (this.playbookDirectiveRepo) {
            try {
              activeDirectives = await this.playbookDirectiveRepo.getActiveDirectives();
            } catch (error) {
              logRuntimeError("SyncService.playbookDirectives", error);
            }
          }
          for (const inc of incidents) {
            const dbId = keyToIdMap.get(inc.incidentKey)!;
            const zoneName = warehouseZoneById.get(inc.warehouseId) || warehouseZoneByName.get(inc.warehouseName) || null;
            const followupState = followupStateByIncidentId.get(dbId) || "NEW";
            const directiveCandidates = selectApplicablePlaybookDirectives(activeDirectives, {
              reasonCode: inc.reasonCode,
              followupState,
              warehouseId: inc.warehouseId,
              zoneName,
            });
            triageByIncidentId.set(dbId, routeIncident({
              ...inc,
              incidentId: dbId,
              followupState,
              actionRequired: true,
              hasConflictingActions: hasConflictingActions(directiveCandidates.map((directive) => ({ action: directive.actionCode, polarity: directive.polarity }))),
              playbookDirectiveCandidates: directiveCandidates.map((directive) => ({
                directiveId: directive.id,
                policyVersion: directive.policyVersion,
                actionCode: directive.actionCode,
                polarity: directive.polarity,
                priority: directive.priority,
              })),
              zoneName,
              pilotZoneNames: TRIAGE_PILOT_ZONES,
            }));
          }

          // Read the prior audit before writing this sync so a promotion out of
          // AUTO_HANDLE is visible across runs without changing Follow-up's state machine.
          const priorTriageByIncidentId = this.triageAuditRepo
            ? new Map((await this.triageAuditRepo.getLatestByIncidentIds([...triageByIncidentId.keys()]))
              .map((triage) => [triage.incidentId, triage]))
            : new Map();

          if (this.triageAuditRepo) {
            await this.triageAuditRepo.recordBatch([...triageByIncidentId.entries()].map(([incidentId, triage]) => ({
              incidentId,
              syncRunId,
              route: triage.route,
              reasonCode: triage.reasonCode,
              severity: triage.severity,
              decisionComplexity: triage.decisionComplexity,
              triageReason: triage.triageReason,
              routingVersion: triage.routingVersion,
              evidence: (() => {
                const promotion = triage.pilotScope
                  ? getRoutePromotion(priorTriageByIncidentId.get(incidentId)?.route, triage)
                  : null;
                return {
                ...triage.evidence,
                aiQueuePolicy: triage.pilotScope ? "PILOT_TRIAGE_GATED" : "OUT_OF_PILOT_LEGACY_QUEUE",
                aiJobEligible: shouldEnqueueAiJob(triage),
                routePromotedFrom: promotion?.from || null,
                routePromotedTo: promotion?.to || null,
                routePromotionReason: promotion?.reason || null,
                routePromotedAt: promotion ? startedAt : null,
              };
              })(),
            })));
          }

          if (this.aiJobRepo && incidents.length > 0) {
            try {
              if (!this.triageAuditRepo) {
                throw new Error("TRIAGE_AUDIT_REQUIRED_FOR_IDEMPOTENT_AI_ENQUEUE");
              }
              const enqueueResult = await this.aiJobRepo.enqueueEligibleForSyncRun(syncRunId);
              successfulEnqueue = enqueueResult.alreadyLinkedCount + enqueueResult.reusedCount + enqueueResult.createdCount;
              if (successfulEnqueue !== enqueueResult.eligibleCount) {
                throw new Error(`AI_ENQUEUE_INCOMPLETE:${successfulEnqueue}/${enqueueResult.eligibleCount}`);
              }
              logger.info({
                component: "SyncService",
                operation: "enqueueAIJobsForRun",
                status: "success",
                message: `[AI Queue] run=${syncRunId} eligible=${enqueueResult.eligibleCount} linked=${enqueueResult.alreadyLinkedCount} reused=${enqueueResult.reusedCount} created=${enqueueResult.createdCount}`,
                metadata: enqueueResult,
              });
            } catch (e: any) {
              logger.info({
                component: "SyncService",
                operation: "enqueueAIJobsForRun",
                status: "error",
                message: `[AI Queue] FAILED syncRunId=${syncRunId}`,
                metadata: { error: e?.message || String(e) },
              });
              throw e;
            }
          }

          const aiDuration = performance.now() - tAiStart;
          logPhaseEnd("enqueueAiJobs", successfulEnqueue);
          await checkpointPhase(pAi);
          logger.info({
              component: "SyncService",
              operation: "phaseAI",
              status: "info",
              message: `[SyncPhase] phase=${pAi} status=completed durationMs=${Math.round(aiDuration)}`
            });
        }

        // Phase 9: REFRESHING_PROJECTIONS
        const pProj = "REFRESHING_PROJECTIONS" as SyncPhase;
        if (completedPhases.includes(pProj)) {
          logger.info({
              component: "SyncService",
              operation: "phaseProjections",
              status: "info",
              message: `[SyncPhase] phase=${pProj} status=skipped durationMs=0`
            });
        } else {
          const tProjStart = performance.now();
          logPhaseStart("refreshProjections");
          await refresh({ source: "sync", changedIncidentIds: [], changedWarehouseIds: [] });
          const projDuration = performance.now() - tProjStart;
          logPhaseEnd("refreshProjections", 0);
          await checkpointPhase(pProj);
          logger.info({
              component: "SyncService",
              operation: "phaseProjections",
              status: "info",
              message: `[SyncPhase] phase=${pProj} status=completed durationMs=${Math.round(projDuration)}`
            });
        }

        // Finalize
        const tFinalizeStart = performance.now();
        logPhaseStart("finalizeSyncRun");
        const completedAt = new Date().toISOString();
        const durationMs = Date.now() - startTime;

        if (this.syncRunRepo) {
          await retryTransientInfrastructure(() => this.syncRunRepo!.updateSuccess(syncRunId, {
              completedAt,
              fetchedOrderCount,
              normalizedOrderCount,
              incidentCount,
              durationMs,
              sourceUpdatedAt,
          }));
        }
        await checkpointPhase("COMPLETED" as SyncPhase);
        if (isSnapshotV3ShadowEnabled() && !pendingSnapshotV3Shadow && this.orderSnapshotRepo?.getSnapshotsForSyncRun) {
          try {
            // A resumed run may have already marked snapshot persistence
            // complete before this process started. Recover the exact legacy
            // cohort only for shadow comparison; production readers are not
            // redirected.
            pendingSnapshotV3Shadow = {
              rows: await this.orderSnapshotRepo.getSnapshotsForSyncRun(syncRunId),
              evaluationReferenceAt: new Date(sourceUpdatedAt || completedAt).toISOString(),
            };
          } catch (error) {
            logger.error({
              component: "SnapshotStorageV3",
              operation: "shadowLegacyRecovery",
              status: "error",
              message: "[SnapshotV3][Shadow] unable to recover completed legacy cohort",
              metadata: { syncRunId, error: safeErrorMessage(error) },
            });
          }
        }
        if (pendingSnapshotV3Shadow) {
          const shadowResult = await runSnapshotV3Shadow({
            shadowRepository: this.snapshotV3ShadowRepo,
            syncRunId,
            rows: pendingSnapshotV3Shadow.rows,
            evaluationReferenceAt: pendingSnapshotV3Shadow.evaluationReferenceAt,
          });
          if (shadowResult.shadowStatus === "SUCCESS") {
            logger.info({
              component: "SnapshotStorageV3",
              operation: "shadowCompare",
              status: "success",
              message: "[SnapshotV3][Shadow] status=matched",
              metadata: { syncRunId, write: shadowResult.write, comparison: shadowResult.comparison },
            });
          } else {
            logger.error({
              component: "SnapshotStorageV3",
              operation: "shadowWrite",
              status: "error",
              message: `[SnapshotV3][Shadow] status=${shadowResult.shadowStatus}`,
              metadata: { syncRunId, error: shadowResult.error, comparison: shadowResult.comparison },
            });
          }
        }
        logger.info({
          component: "SyncService",
          operation: "phaseCompleted",
          status: "info",
          message: `[SyncPhase] phase=COMPLETED status=completed durationMs=${durationMs}`
        });
        recordPhase("finalizeSyncRun", performance.now() - tFinalizeStart, 1, 1, 1, 1, "Finalized sync_runs status = success");

        return {
          ok: true,
          syncRunId,
          startedAt,
          completedAt,
          durationMs,
          fetchedOrderCount,
          normalizedOrderCount,
          incidentCount,
          followupEvaluation: summarizeFollowupEvaluation(incidents, followupResults),
          resolvedIncidentCount,
          phaseTimings,
          dbInstrumentation: {
            totalQueries,
            phases: dbPhases,
            bottlenecksDetected,
          },
          syncLockAttempts: syncLockTelemetry?.attempts || 0,
          syncLockRetryCount: syncLockTelemetry?.retryCount || 0,
          syncLockFinalStatus: syncLockTelemetry?.finalStatus || "NOT_ATTEMPTED",
        };
      } catch (err: unknown) {
        logRuntimeError("SyncService.runSync", err);
        const completedAt = new Date().toISOString();
        const durationMs = Date.now() - startTime;
        const sanitizedMessage = safeErrorMessage(err);
        const errorCode = safeErrorCode(err);

        logger.info({
          component: "SyncService",
          operation: "runSync",
          status: "error",
          message: `[SyncPhase] phase=${completedPhases[completedPhases.length - 1] || "FAILED"} status=failed durationMs=${durationMs}`
        });

        if (this.syncRunRepo && isPersistedUuid(syncRunId)) {
          try {
            await retryTransientInfrastructure(() => this.syncRunRepo!.updateFailed(syncRunId, {
              completedAt,
              durationMs,
              errorCode,
              errorMessage: sanitizedMessage,
            }));
          } catch {
            // Fallback
          }
        }

        return {
          ok: false,
          syncRunId,
          startedAt,
          completedAt,
          durationMs,
          fetchedOrderCount: 0,
          normalizedOrderCount: 0,
          incidentCount: 0,
          phaseTimings,
          dbInstrumentation: {
            totalQueries,
            phases: dbPhases,
            bottlenecksDetected,
          },
          error: {
            code: errorCode,
            message: sanitizedMessage,
          },
          syncLockAttempts: syncLockTelemetry?.attempts || 0,
          syncLockRetryCount: syncLockTelemetry?.retryCount || 0,
          syncLockFinalStatus: syncLockTelemetry?.finalStatus || "NOT_ATTEMPTED",
        };
      }
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      if (this.syncLockRepo && lockAcquired) {
        try {
          const released = await this.syncLockRepo.releaseLock(lockKey, ownerId);
          logger.info({
            component: "SyncService",
            operation: "releaseLock",
            status: "info",
            message: `[SyncLock] event=release status=${released ? "success" : "not_owner"} lockKey=${lockKey}`
          });
        } catch (e: any) {
          logger.info({
            component: "SyncService",
            operation: "releaseLock",
            status: "error",
            message: `[SyncLock] event=release status=failed lockKey=${lockKey}`,
            metadata: { error: e?.message || String(e) }
          });
        }
      }
    }
  }
}
