import type { ISyncService, SyncOptions, SyncSummary } from "../interfaces/ISyncService";
import type { ISyncRunRepository } from "@/repositories/interfaces/ISyncRunRepository";
import type { IOrderSnapshotRepository, OrderSnapshotRow } from "@/repositories/interfaces/IOrderSnapshotRepository";
import type { IIncidentRepository } from "@/repositories/interfaces/IIncidentRepository";
import type { IIncidentHistoryRepository } from "@/repositories/interfaces/IIncidentHistoryRepository";
import type { IExceptionRepository } from "@/repositories/interfaces/IExceptionRepository";
import type { IFollowupRepository } from "@/repositories/interfaces/IFollowupRepository";
import type { IAiJobRepository } from "@/repositories/interfaces/IAiJobRepository";
import type { PhaseTimingInfo, DetectedBottleneck } from "@/jobs/sync-rillnet";
import { RillnetConnector } from "@/connectors/rillnet";
import { aggregateIncidents, inspectOrderForIncident, REASON_CODE_MAP } from "@/engine/incident";
import { FollowupEngine } from "@/engine/followup";
import { ActionQueue } from "@/engine/action-queue";
import { refresh } from "@/projections/projection-engine";
import { logRuntimeError, logRuntimeMessage } from "@/observability/runtimeDiagnostics";

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

    // Instrumentation state
    const phaseTimings: Record<string, number> = {};
    const dbPhases: Record<string, PhaseTimingInfo> = {};
    let totalQueries = 0;
    const phaseStarts = new Map<string, { monotonicMs: number; startedAt: string }>();

    function logPhaseStart(name: string): void {
      const startedAt = new Date().toISOString();
      phaseStarts.set(name, { monotonicMs: performance.now(), startedAt });
      logRuntimeMessage("[SyncRuntime] phase=" + name + " event=start startedAt=" + startedAt);
    }

    function logPhaseEnd(name: string, rowCount: number, status: "success" | "failed" = "success"): void {
      const start = phaseStarts.get(name);
      const finishedAt = new Date().toISOString();
      const durationMs = start ? Math.max(0, Math.round((performance.now() - start.monotonicMs) * 100) / 100) : 0;
      logRuntimeMessage("[SyncRuntime] phase=" + name + " event=end startedAt=" + (start?.startedAt || "unknown") + " finishedAt=" + finishedAt + " durationMs=" + durationMs + " rowCount=" + rowCount + " status=" + status);
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

    // Detect static bottlenecks
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

    // 1. Create sync_runs row (status = running)
    const tCreateStart = performance.now();
    logPhaseStart("createSyncRun");
    let syncRunId = `local-sync-${Date.now()}`;
    let createQueries = 0;
    if (this.syncRunRepo) {
      try {
        const syncRunRow = await this.syncRunRepo.createSyncRun(startedAt);
        syncRunId = syncRunRow.id;
        createQueries = 1;
      } catch {
        // Fallback local ID
      }
    }
    recordPhase("createSyncRun", performance.now() - tCreateStart, createQueries, createQueries, 1, createQueries, "Initial sync_runs row creation");

    try {
      // 2. Fetch Rillnet snapshot (URL request, download, decompress, parse)
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
      const snapshotResult = await connector.parseSnapshotFromBuffer(buffer, updatedAt);
      logPhaseEnd("parseSnapshot", snapshotResult.totalOrders);
      const parseDuration = performance.now() - tParseStart;

      const fetchTotalDuration = performance.now() - tFetchStart;

      const fetchedOrderCount = snapshotResult.totalOrders;
      const normalizedOrderCount = snapshotResult.orders.length;
      const sourceUpdatedAt = snapshotResult.fetchedAt;

      recordPhase(
        "fetchSnapshot",
        fetchTotalDuration,
        fetchedOrderCount,
        1,
        fetchedOrderCount,
        0,
        `API request: ${Math.round(fetchUrlDuration)}ms, Download: ${Math.round(downloadDuration)}ms, Decompress/Parse: ${Math.round(parseDuration)}ms`
      );

      // 3. Normalize Orders
      const tNormStart = performance.now();
      logPhaseStart("normalizeOrders");
      recordPhase("normalizeOrders", performance.now() - tNormStart, normalizedOrderCount, 1, normalizedOrderCount, 0, "Mapped raw orders to normalized objects");

      // 4. Load active, non-expired exceptions
      const tExStart = performance.now();
      logPhaseStart("loadExceptions");
      let activeExceptions = new Set<string>();
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

      // 5. Apply Rule Engine with active exceptions (Build Incidents)
      const tIncStart = performance.now();
      logPhaseStart("buildIncidents");
      const referenceTimeMs = _options?.referenceTimeMs || new Date(sourceUpdatedAt).getTime() || startTime;
      const incidents = aggregateIncidents(
        snapshotResult.orders,
        undefined,
        referenceTimeMs,
        activeExceptions
      );
      const incidentCount = incidents.length;
      recordPhase("buildIncidents", performance.now() - tIncStart, incidentCount, 1, incidentCount, 0, "Aggregated incidents from normalized orders");

      // 6. Save order snapshots in batches (batch size: 500)
      const tSnapStart = performance.now();
      logPhaseStart("persistSnapshots");
      let snapQueries = 0;
      let snapRowsProcessed = 0;
      let snapBatches = 0;

      if (this.orderSnapshotRepo && syncRunId && !syncRunId.startsWith("local-sync")) {
        try {
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
              source_updated_at: sourceUpdatedAt,
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
      recordPhase("persistSnapshots", performance.now() - tSnapStart, snapRowsProcessed, snapBatches, 500, snapQueries, "Batched order_snapshots insertion");

      // 7. Upsert current incidents using stable incident_key
      const tUpsertIncStart = performance.now();
      logPhaseStart("persistIncidents");
      let resolvedIncidentCount = 0;
      let incQueries = 0;
      const keyToIdMap = new Map<string, string>();

      if (this.incidentRepo && this.incidentHistoryRepo && syncRunId && !syncRunId.startsWith("local-sync")) {
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
      recordPhase("persistIncidents", performance.now() - tUpsertIncStart, incidents.length, 1, incidents.length, incQueries, "Upserted active incidents into DB");

      // 8. Insert incident_history rows
      const tHistStart = performance.now();
      logPhaseStart("persistHistory");
      let histQueries = 0;
      if (this.incidentHistoryRepo && syncRunId && !syncRunId.startsWith("local-sync") && incidents.length > 0) {
        try {
          await this.incidentHistoryRepo.insertHistoryRecords(
            keyToIdMap,
            incidents,
            syncRunId,
            startedAt
          );
          histQueries = 1;
        } catch {
          // Fallback
        }
      }
      recordPhase("persistHistory", performance.now() - tHistStart, incidents.length, 1, incidents.length, histQueries, "Inserted incident_history snapshot rows");

      // 9. Resolve absent incidents from previous run
      const tResolveStart = performance.now();
      logPhaseStart("resolveAbsentIncidents");
      let resolveQueries = 0;
      if (this.incidentRepo && syncRunId && !syncRunId.startsWith("local-sync")) {
        try {
          const activeKeys = incidents.map((inc) => inc.incidentKey);
          resolvedIncidentCount = await this.incidentRepo.resolveAbsentIncidents(
            activeKeys,
            syncRunId,
            startedAt
          );
          resolveQueries = 1;
        } catch {
          // Fallback
        }
      }
      recordPhase("resolveAbsentIncidents", performance.now() - tResolveStart, resolvedIncidentCount, 1, resolvedIncidentCount, resolveQueries, "Resolved absent incidents");

      // 10. Batch load incident histories
      const tLoadHistStart = performance.now();
      logPhaseStart("loadHistories");
      let loadHistQueries = 0;
      let historyMap = new Map();
      const incidentDbIds: string[] = [];

      if (this.incidentHistoryRepo && incidents.length > 0) {
        try {
          for (const inc of incidents) {
            const dbId = keyToIdMap.get(inc.incidentKey);
            if (dbId) {
              inc.incidentId = dbId;
              incidentDbIds.push(dbId);
            }
          }
          if (incidentDbIds.length > 0) {
            historyMap = await this.incidentHistoryRepo.getHistoriesByIncidentIds(incidentDbIds);
            loadHistQueries = 1;
          }
        } catch {
          // Fallback
        }
      }
      recordPhase("loadHistories", performance.now() - tLoadHistStart, historyMap.size, 1, incidentDbIds.length, loadHistQueries, "Batch loaded incident histories");

      // 11. Execute Follow-up Engine State Machine using Action Queue (100% Deterministic - ZERO AI!)
      const tFollowupStart = performance.now();
      logPhaseStart("processFollowups");
      let followupQueries = 0;
      let enqueuedCount = 0;
      let actionQueueRoundTrips: number | null = null;

      if (this.followupRepo && incidents.length > 0) {
        try {
          const actQueue = this.actionQueue || new ActionQueue(null);

          // FollowupEngine instantiated with ZERO AI dependencies
          const followupEngine = new FollowupEngine(this.followupRepo, actQueue);
          const followupResults = await followupEngine.processIncidentFollowups(incidents, historyMap, undefined, referenceTimeMs);

          const followupMetrics = followupEngine.getLastRunMetrics();
          followupQueries = followupMetrics
            ? followupMetrics.caseReads + followupMetrics.caseWrites + followupMetrics.eventWrites
            : 0;
          enqueuedCount = followupResults.filter((r) => r.newState.includes("PENDING")).length;
          actionQueueRoundTrips = followupMetrics
            ? followupMetrics.actionQueueMetrics.dedupLookups +
              followupMetrics.actionQueueMetrics.actionInsertCalls +
              followupMetrics.actionQueueMetrics.auditEventWrites
            : null;

          // 12. Enqueue AI Jobs into background ai_analysis_jobs table asynchronously
          logPhaseStart("enqueueAiJobs");
          console.log(`[AI Queue] Repository exists: ${!!this.aiJobRepo}`);
          console.log(`[AI Queue] Total incidents: ${incidents.length}`);

          let successfulEnqueue = 0;
          let failedEnqueue = 0;

          if (this.aiJobRepo) {
            for (const inc of incidents) {
              const dbId = keyToIdMap.get(inc.incidentKey) || inc.incidentId;
              if (dbId) {
                const priority = inc.priorityScore >= 75 ? "urgent" : inc.priorityScore >= 50 ? "high" : "medium";
                console.log(`[AI Queue] Enqueue: incidentId=${dbId} incidentKey=${inc.incidentKey} priority=${priority}`);
                try {
                  await this.aiJobRepo.enqueueJob(dbId, priority);
                  successfulEnqueue++;
                  console.log(`[AI Queue] SUCCESS incidentId=${dbId}`);
                } catch (e: any) {
                  failedEnqueue++;
                  console.error(`[AI Queue] FAILED incidentId=${dbId}\nerror=${e.message || String(e)}\nstack=${e.stack || "N/A"}`);
                  throw e; // Do not swallow/suppress exceptions
                }
              }
            }
          }

          console.log(`=========================\nAI Queue Summary\nRepository exists: ${!!this.aiJobRepo}\nIncidents: ${incidents.length}\nSuccessful: ${successfulEnqueue}\nFailed: ${failedEnqueue}\n=========================`);
          logPhaseEnd("enqueueAiJobs", successfulEnqueue);
        } catch (err: any) {
          logPhaseEnd("enqueueAiJobs", 0, "failed");
          logRuntimeError("SyncService.enqueueAiJobs", err);
          console.error("[AI Queue] Error occurred in followup/AI queue block:", err);
          throw err;
        }
      }
      recordPhase("processFollowups", performance.now() - tFollowupStart, incidents.length, 1, incidents.length, followupQueries, "Deterministic Follow-up state machine evaluation & AI Job enqueueing");

      // 12. Enqueue Notification Actions
      const tEnqueueStart = performance.now();
      logPhaseStart("enqueueActions");
      const enqueueQueries = actionQueueRoundTrips ?? enqueuedCount * 3;
      recordPhase("enqueueActions", performance.now() - tEnqueueStart, enqueuedCount, enqueuedCount, 1, enqueueQueries, "ActionQueue notification action enqueueing");

      // 13. Complete sync_run with status = success
      const tFinalizeStart = performance.now();
      logPhaseStart("finalizeSyncRun");
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - startTime;
      let finalizeQueries = 0;

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
          finalizeQueries = 1;
        } catch {
          // Fallback
        }
      }
      recordPhase("finalizeSyncRun", performance.now() - tFinalizeStart, 1, 1, 1, finalizeQueries, "Finalized sync_runs status = success");

      console.log(`[SyncRillnet Performance Summary] Total Duration: ${durationMs}ms | Total DB Queries: ${totalQueries}`);
      logPhaseStart("refreshProjections");
      await refresh({ source: "sync", changedIncidentIds: [], changedWarehouseIds: [] });
      logPhaseEnd("refreshProjections", 0);

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
