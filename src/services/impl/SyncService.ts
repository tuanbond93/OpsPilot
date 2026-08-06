import type { ISyncService, SyncOptions, SyncSummary } from "../interfaces/ISyncService";
import type { ISyncRunRepository } from "@/repositories/interfaces/ISyncRunRepository";
import type { IOrderSnapshotRepository, OrderSnapshotRow } from "@/repositories/interfaces/IOrderSnapshotRepository";
import type { IIncidentRepository } from "@/repositories/interfaces/IIncidentRepository";
import type { IIncidentHistoryRepository } from "@/repositories/interfaces/IIncidentHistoryRepository";
import type { IExceptionRepository } from "@/repositories/interfaces/IExceptionRepository";
import type { IFollowupRepository } from "@/repositories/interfaces/IFollowupRepository";
import type { IAiJobRepository } from "@/repositories/interfaces/IAiJobRepository";
import type { PhaseTimingInfo, DetectedBottleneck } from "@/jobs/sync-rillnet";
import type { SyncPhase, SyncRunRow } from "@/connectors/supabase/types";
import { RillnetConnector } from "@/connectors/rillnet";
import { aggregateIncidents, inspectOrderForIncident, REASON_CODE_MAP } from "@/engine/incident";
import { FollowupEngine } from "@/engine/followup";
import { ActionQueue } from "@/engine/action-queue";
import { refresh } from "@/projections/projection-engine";
import { logRuntimeError, logRuntimeMessage } from "@/observability/runtimeDiagnostics";

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

export class SyncService implements ISyncService {
  constructor(
    private syncRunRepo: ISyncRunRepository | null = null,
    private orderSnapshotRepo: IOrderSnapshotRepository | null = null,
    private incidentRepo: IIncidentRepository | null = null,
    private incidentHistoryRepo: IIncidentHistoryRepository | null = null,
    private exceptionRepo: IExceptionRepository | null = null,
    private followupRepo: IFollowupRepository | null = null,
    private aiJobRepo: IAiJobRepository | null = null,
    private actionQueue: ActionQueue | null = null
  ) {}

  async runSync(_options?: SyncOptions): Promise<SyncSummary> {
    const startTime = Date.now();
    const startedAt = new Date(startTime).toISOString();

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
      console.log(
        `[SyncRillnet Performance Instrumentation] Phase: ${name} | Duration: ${roundedDuration}ms | Queries: ${queryCount} | Rows: ${rowsProcessed} | Batches: ${batchCount} (size: ${batchSize})${
          details ? ` | Note: ${details}` : ""
        }`
      );
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

    // 1. Resume Check & State Rehydration
    let syncRunId = `local-sync-${Date.now()}`;
    let completedPhases: SyncPhase[] = [];

    if (this.syncRunRepo) {
      try {
        const unfinishedRun: SyncRunRow | null = await this.syncRunRepo.getUnfinishedSyncRun();
        if (unfinishedRun && unfinishedRun.id && !unfinishedRun.id.startsWith("local-sync")) {
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

          const snapshotInRam = Array.isArray(snapshotResult.orders) && snapshotResult.orders.length > 0;
          const { safePhase, reason } = getSafeResumePhase(requestedResume, { snapshotInRam, incidentsRehydrated });

          if (reason) {
            console.log(`[SyncRecovery] syncRun=${syncRunId} requestedResume=${requestedResume} safeResume=${safePhase} reason=${reason}`);
          } else {
            console.log(`[SyncResume] syncRun=${syncRunId} resumeFrom=${safePhase}`);
            console.log(`[SyncRecovery] previousRunRecovered=true completedPhases=${completedPhases.length}`);
          }

          // Truncate completedPhases to only include phases strictly prior to safePhase
          const safeIdx = ORDERED_SYNC_PHASES.indexOf(safePhase);
          completedPhases = ORDERED_SYNC_PHASES.slice(0, safeIdx);
        } else {
          const newRun = await this.syncRunRepo.createSyncRun(startedAt);
          syncRunId = newRun.id;
          completedPhases = ["CREATED"];
          console.log(`[SyncPhase] phase=CREATED status=completed durationMs=0`);
        }
      } catch {
        completedPhases = ["CREATED"];
      }
    } else {
      completedPhases = ["CREATED"];
    }

    const checkpointPhase = async (phase: SyncPhase) => {
      if (!completedPhases.includes(phase)) {
        completedPhases.push(phase);
        if (this.syncRunRepo && !syncRunId.startsWith("local-sync")) {
          try {
            await this.syncRunRepo.updatePhase(syncRunId, phase, completedPhases);
          } catch {
            // Non-fatal
          }
        }
      }
    };

    try {
      // Phase 2: FETCHING_SNAPSHOT
      const pFetch = "FETCHING_SNAPSHOT" as SyncPhase;
      if (completedPhases.includes(pFetch) && snapshotResult.orders && snapshotResult.orders.length > 0) {
        console.log(`[SyncPhase] phase=${pFetch} status=skipped durationMs=0`);
      } else {
        const tFetchStart = performance.now();
        logPhaseStart("fetchSnapshot");
        const connector = new RillnetConnector();

        const tUrlStart = performance.now();
        logPhaseStart("fetchSnapshotUrlOnly");
        const { downloadUrl, updatedAt } = await connector.fetchSnapshotUrlOnly();
        logPhaseEnd("fetchSnapshotUrlOnly", 1);
        const fetchUrlDuration = performance.now() - tUrlStart;

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
        console.log(`[SyncPhase] phase=${pFetch} status=completed durationMs=${Math.round(fetchTotalDuration)}`);
      }

      // Re-normalize and load exceptions if snapshot is available
      if (snapshotResult.orders && snapshotResult.orders.length > 0) {
        const tNormStart = performance.now();
        logPhaseStart("normalizeOrders");
        normalizedOrderCount = snapshotResult.orders.length;
        recordPhase("normalizeOrders", performance.now() - tNormStart, normalizedOrderCount, 1, normalizedOrderCount, 0, "Mapped raw orders to normalized objects");

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
        console.log(`[SyncPhase] phase=${pSnap} status=skipped durationMs=0`);
      } else {
        const tSnapStart = performance.now();
        logPhaseStart("persistSnapshots");
        let snapQueries = 0;
        let snapRowsProcessed = 0;
        let snapBatches = 0;

        if (this.orderSnapshotRepo && syncRunId && !syncRunId.startsWith("local-sync") && snapshotResult.orders) {
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
              });
            }

            snapRowsProcessed = snapshotRows.length;
            snapBatches = Math.ceil(snapshotRows.length / 500);
            snapQueries = snapBatches;

            await this.orderSnapshotRepo.insertBatch(snapshotRows, 500);
          } catch {
            // Fallback
          }
        }
        const snapDuration = performance.now() - tSnapStart;
        recordPhase("persistSnapshots", snapDuration, snapRowsProcessed, snapBatches, 500, snapQueries, "Batched order_snapshots insertion");
        await checkpointPhase(pSnap);
        console.log(`[SyncPhase] phase=${pSnap} status=completed durationMs=${Math.round(snapDuration)}`);
      }

      // Phase 4: PERSISTING_INCIDENTS
      const pInc = "PERSISTING_INCIDENTS" as SyncPhase;
      if (completedPhases.includes(pInc) && incidents.length > 0) {
        console.log(`[SyncPhase] phase=${pInc} status=skipped durationMs=0`);
      } else {
        const tUpsertIncStart = performance.now();
        logPhaseStart("persistIncidents");
        let incQueries = 0;

        if (this.incidentRepo && syncRunId && !syncRunId.startsWith("local-sync") && incidents.length > 0) {
          try {
            const savedIncidentRows = await this.incidentRepo.upsertIncidents(incidents, syncRunId);
            incQueries = 1;
            for (const row of savedIncidentRows) {
              keyToIdMap.set(row.incident_key, row.id);
            }
          } catch {
            // Fallback
          }
        }
        const incDuration = performance.now() - tUpsertIncStart;
        recordPhase("persistIncidents", incDuration, incidents.length, 1, incidents.length, incQueries, "Upserted active incidents into DB");
        await checkpointPhase(pInc);
        console.log(`[SyncPhase] phase=${pInc} status=completed durationMs=${Math.round(incDuration)}`);
      }

      // Phase 5: PERSISTING_HISTORY
      const pHist = "PERSISTING_HISTORY" as SyncPhase;
      if (completedPhases.includes(pHist)) {
        console.log(`[SyncPhase] phase=${pHist} status=skipped durationMs=0`);
      } else {
        const tHistStart = performance.now();
        logPhaseStart("persistHistory");
        let histQueries = 0;

        if (this.incidentHistoryRepo && syncRunId && !syncRunId.startsWith("local-sync") && incidents.length > 0) {
          try {
            await this.incidentHistoryRepo.insertHistoryRecords(keyToIdMap, incidents, syncRunId, startedAt);
            histQueries = 1;
          } catch {
            // Fallback
          }
        }
        const histDuration = performance.now() - tHistStart;
        recordPhase("persistHistory", histDuration, incidents.length, 1, incidents.length, histQueries, "Inserted incident_history snapshot rows");

        if (this.incidentRepo && syncRunId && !syncRunId.startsWith("local-sync")) {
          try {
            const activeKeys = incidents.map((inc) => inc.incidentKey);
            resolvedIncidentCount = await this.incidentRepo.resolveAbsentIncidents(activeKeys, syncRunId, startedAt);
          } catch {
            // Fallback
          }
        }
        await checkpointPhase(pHist);
        console.log(`[SyncPhase] phase=${pHist} status=completed durationMs=${Math.round(histDuration)}`);
      }

      // Load incident histories for follow-up evaluation
      let historyMap = new Map();
      const incidentDbIds: string[] = [];
      if (this.incidentHistoryRepo && incidents.length > 0) {
        try {
          for (const inc of incidents) {
            const dbId = keyToIdMap.get(inc.incidentKey) || inc.incidentId;
            if (dbId) {
              inc.incidentId = dbId;
              incidentDbIds.push(dbId);
            }
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
        console.log(`[SyncPhase] phase=${pFol} status=skipped durationMs=0`);
      } else {
        const tFollowupStart = performance.now();
        logPhaseStart("processFollowups");
        let followupQueries = 0;

        if (this.followupRepo && incidents.length > 0) {
          const referenceTimeMs = _options?.referenceTimeMs || (sourceUpdatedAt ? new Date(sourceUpdatedAt).getTime() : startTime);
          const actQueue = this.actionQueue || new ActionQueue(null);
          const followupEngine = new FollowupEngine(this.followupRepo, actQueue);
          followupResults = await followupEngine.processIncidentFollowups(incidents, historyMap, undefined, referenceTimeMs);
          const followupMetrics = followupEngine.getLastRunMetrics();
          followupQueries = followupMetrics ? followupMetrics.caseReads + followupMetrics.caseWrites + followupMetrics.eventWrites : 0;
        }

        const folDuration = performance.now() - tFollowupStart;
        recordPhase("processFollowups", folDuration, incidents.length, 1, incidents.length, followupQueries, "Deterministic Follow-up state machine evaluation");
        await checkpointPhase(pFol);
        console.log(`[SyncPhase] phase=${pFol} status=completed durationMs=${Math.round(folDuration)}`);
      }

      // Phase 7: ENQUEUE_NOTIFICATIONS
      const pNotif = "ENQUEUE_NOTIFICATIONS" as SyncPhase;
      if (completedPhases.includes(pNotif)) {
        console.log(`[SyncPhase] phase=${pNotif} status=skipped durationMs=0`);
      } else {
        const tEnqueueStart = performance.now();
        logPhaseStart("enqueueActions");
        const enqueuedCount = followupResults.filter((r) => r.newState && r.newState.includes("PENDING")).length;
        recordPhase("enqueueActions", performance.now() - tEnqueueStart, enqueuedCount, enqueuedCount, 1, 0, "ActionQueue notification action enqueueing");
        await checkpointPhase(pNotif);
        console.log(`[SyncPhase] phase=${pNotif} status=completed durationMs=0`);
      }

      // Phase 8: ENQUEUE_AI
      const pAi = "ENQUEUE_AI" as SyncPhase;
      if (completedPhases.includes(pAi)) {
        console.log(`[SyncPhase] phase=${pAi} status=skipped durationMs=0`);
      } else {
        const tAiStart = performance.now();
        logPhaseStart("enqueueAiJobs");
        let successfulEnqueue = 0;

        if (this.aiJobRepo && incidents.length > 0) {
          for (const inc of incidents) {
            const dbId = keyToIdMap.get(inc.incidentKey) || inc.incidentId;
            if (dbId) {
              const priority = inc.priorityScore >= 75 ? "urgent" : inc.priorityScore >= 50 ? "high" : "medium";
              try {
                await this.aiJobRepo.enqueueJob(dbId, priority);
                successfulEnqueue++;
              } catch (e: any) {
                console.error(`[AI Queue] FAILED incidentId=${dbId}`, e);
                throw e;
              }
            }
          }
        }

        const aiDuration = performance.now() - tAiStart;
        logPhaseEnd("enqueueAiJobs", successfulEnqueue);
        await checkpointPhase(pAi);
        console.log(`[SyncPhase] phase=${pAi} status=completed durationMs=${Math.round(aiDuration)}`);
      }

      // Phase 9: REFRESHING_PROJECTIONS
      const pProj = "REFRESHING_PROJECTIONS" as SyncPhase;
      if (completedPhases.includes(pProj)) {
        console.log(`[SyncPhase] phase=${pProj} status=skipped durationMs=0`);
      } else {
        const tProjStart = performance.now();
        logPhaseStart("refreshProjections");
        await refresh({ source: "sync", changedIncidentIds: [], changedWarehouseIds: [] });
        const projDuration = performance.now() - tProjStart;
        logPhaseEnd("refreshProjections", 0);
        await checkpointPhase(pProj);
        console.log(`[SyncPhase] phase=${pProj} status=completed durationMs=${Math.round(projDuration)}`);
      }

      // Finalize
      const tFinalizeStart = performance.now();
      logPhaseStart("finalizeSyncRun");
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - startTime;

      if (this.syncRunRepo && !syncRunId.startsWith("local-sync")) {
        try {
          await this.syncRunRepo.updateSuccess(syncRunId, {
            completedAt,
            fetchedOrderCount,
            normalizedOrderCount,
            incidentCount,
            durationMs,
            sourceUpdatedAt,
          });
        } catch {
          // Fallback
        }
      }
      await checkpointPhase("COMPLETED" as SyncPhase);
      console.log(`[SyncPhase] phase=COMPLETED status=completed durationMs=${durationMs}`);
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
        resolvedIncidentCount,
        phaseTimings,
        dbInstrumentation: {
          totalQueries,
          phases: dbPhases,
          bottlenecksDetected,
        },
      };
    } catch (err: unknown) {
      logRuntimeError("SyncService.runSync", err);
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - startTime;
      const rawMessage = err instanceof Error ? err.message : String(err);
      const sanitizedMessage = rawMessage.replace(/https?:\/\/[^\s]+/g, "[URL REDACTED]");
      const errorCode = err instanceof Error ? err.name : "SyncError";

      console.error(`[SyncPhase] phase=${completedPhases[completedPhases.length - 1] || "FAILED"} status=failed durationMs=${durationMs}`);

      if (this.syncRunRepo && !syncRunId.startsWith("local-sync")) {
        try {
          await this.syncRunRepo.updateFailed(syncRunId, {
            completedAt,
            durationMs,
            errorCode,
            errorMessage: sanitizedMessage,
          });
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
      };
    }
  }
}
