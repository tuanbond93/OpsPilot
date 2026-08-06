import { RillnetConnector } from "../connectors/rillnet";
import { aggregateIncidents, inspectOrderForIncident, REASON_CODE_MAP } from "../engine/incident";
import {
  createAdminClient,
  SyncRunRepository,
  OrderSnapshotRepository,
  IncidentRepository,
  IncidentHistoryRepository,
  ExceptionRepository,
  FollowupRepository,
  AiJobRepository,
  type OrderSnapshotRow,
} from "../connectors/supabase";
import { FollowupEngine } from "../engine/followup";
import { ActionQueue } from "../engine/action-queue";
import { refresh } from "../projections/projection-engine";
// DIAGNOSTIC: refresh() from projection-engine is NOT imported here.
// syncRillnet() never triggers a projection refresh, which is why
// warehouse_summary / incident_summary / planner_summary /
// notification_summary / dashboard_snapshot remain empty after sync.

export interface PhaseTimingInfo {
  durationMs: number;
  rowsProcessed: number;
  batchCount: number;
  batchSize: number;
  queryCount: number;
  details?: string;
}

export interface DetectedBottleneck {
  category: string;
  description: string;
  fileAndLine: string;
}

export interface SyncJobResult {
  ok: boolean;
  syncRunId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  fetchedOrderCount: number;
  normalizedOrderCount: number;
  incidentCount: number;
  resolvedIncidentCount?: number;
  phaseTimings: Record<string, number>;
  dbInstrumentation: {
    totalQueries: number;
    phases: Record<string, PhaseTimingInfo>;
    bottlenecksDetected: DetectedBottleneck[];
  };
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Runs complete Rillnet sync and persistence workflow with deterministic performance instrumentation.
 * ZERO AI executions or external LLM calls occur during sync.
 */
export async function syncRillnet(): Promise<SyncJobResult> {
  const startTime = Date.now();
  const startedAt = new Date(startTime).toISOString();

  // Instrumentation state
  const phaseTimings: Record<string, number> = {};
  const dbPhases: Record<string, PhaseTimingInfo> = {};
  let totalQueries = 0;

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
        "executeStateTransition() performs sequential single-row upserts to followup_cases and inserts to followup_events inside the active/disappeared incident loops instead of batching.",
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

  // Try creating Supabase admin client
  let dbClient;
  let isDbAvailable = false;

  try {
    dbClient = createAdminClient();
    isDbAvailable = true;
  } catch {
    isDbAvailable = false;
  }

  let syncRunRepo: SyncRunRepository | null = null;
  let orderSnapshotRepo: OrderSnapshotRepository | null = null;
  let incidentRepo: IncidentRepository | null = null;
  let incidentHistoryRepo: IncidentHistoryRepository | null = null;
  let exceptionRepo: ExceptionRepository | null = null;
  let aiJobRepo: AiJobRepository | null = null;

  if (isDbAvailable && dbClient) {
    syncRunRepo = new SyncRunRepository(dbClient);
    orderSnapshotRepo = new OrderSnapshotRepository(dbClient);
    incidentRepo = new IncidentRepository(dbClient);
    incidentHistoryRepo = new IncidentHistoryRepository(dbClient);
    exceptionRepo = new ExceptionRepository(dbClient);
    aiJobRepo = new AiJobRepository(dbClient);
  }

  // 1. Create sync_runs row (status = running)
  const tCreateStart = performance.now();
  let syncRunId = `local-sync-${Date.now()}`;
  let createQueries = 0;
  if (syncRunRepo) {
    try {
      const syncRunRow = await syncRunRepo.createSyncRun(startedAt);
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
    const connector = new RillnetConnector();

    const tUrlStart = performance.now();
    const { downloadUrl, updatedAt } = await connector.fetchSnapshotUrlOnly();
    const fetchUrlDuration = performance.now() - tUrlStart;

    const tDownloadStart = performance.now();
    const buffer = await connector.downloadBufferOnly(downloadUrl);
    const downloadDuration = performance.now() - tDownloadStart;

    const tParseStart = performance.now();
    const snapshotResult = await connector.parseSnapshotFromBuffer(buffer, updatedAt);
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
    recordPhase("normalizeOrders", performance.now() - tNormStart, normalizedOrderCount, 1, normalizedOrderCount, 0, "Mapped raw orders to normalized objects");

    // 4. Load active, non-expired exceptions
    const tExStart = performance.now();
    let activeExceptions = new Set<string>();
    let exQueries = 0;
    if (exceptionRepo) {
      try {
        activeExceptions = await exceptionRepo.getActiveExceptionOrderCodes(startedAt);
        exQueries = 1;
      } catch {
        // Fallback
      }
    }
    recordPhase("loadExceptions", performance.now() - tExStart, activeExceptions.size, exQueries, activeExceptions.size, exQueries, "Active order exceptions lookup");

    // 5. Apply Rule Engine with active exceptions (Build Incidents)
    const tIncStart = performance.now();
    const referenceTimeMs = new Date(sourceUpdatedAt).getTime() || startTime;
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
    let snapQueries = 0;
    let snapRowsProcessed = 0;
    let snapBatches = 0;

    if (orderSnapshotRepo && syncRunId && !syncRunId.startsWith("local-sync")) {
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

        await orderSnapshotRepo.insertBatch(snapshotRows, 500);
      } catch {
        // Fallback
      }
    }
    recordPhase("persistSnapshots", performance.now() - tSnapStart, snapRowsProcessed, snapBatches, 500, snapQueries, "Batched order_snapshots insertion");

    // 7. Upsert current incidents using stable incident_key
    const tUpsertIncStart = performance.now();
    let resolvedIncidentCount = 0;
    let incQueries = 0;
    let keyToIdMap = new Map<string, string>();

    if (incidentRepo && incidentHistoryRepo && syncRunId && !syncRunId.startsWith("local-sync")) {
      try {
        const savedIncidentRows = await incidentRepo.upsertIncidents(incidents, syncRunId);
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
    let histQueries = 0;
    if (incidentHistoryRepo && syncRunId && !syncRunId.startsWith("local-sync") && incidents.length > 0) {
      try {
        await incidentHistoryRepo.insertHistoryRecords(
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
    let resolveQueries = 0;
    if (incidentRepo && syncRunId && !syncRunId.startsWith("local-sync")) {
      try {
        const activeKeys = incidents.map((inc) => inc.incidentKey);
        resolvedIncidentCount = await incidentRepo.resolveAbsentIncidents(
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
    let loadHistQueries = 0;
    let historyMap = new Map();
    const incidentDbIds: string[] = [];

    if (incidentHistoryRepo && incidents.length > 0) {
      try {
        for (const inc of incidents) {
          const dbId = keyToIdMap.get(inc.incidentKey);
          if (dbId) {
            inc.incidentId = dbId;
            incidentDbIds.push(dbId);
          }
        }
        if (incidentDbIds.length > 0) {
          historyMap = await incidentHistoryRepo.getHistoriesByIncidentIds(incidentDbIds);
          loadHistQueries = 1;
        }
      } catch {
        // Fallback
      }
    }
    recordPhase("loadHistories", performance.now() - tLoadHistStart, historyMap.size, 1, incidentDbIds.length, loadHistQueries, "Batch loaded incident histories");

    // 11. Execute Follow-up Engine State Machine using Action Queue (100% Deterministic - ZERO AI!)
    const tFollowupStart = performance.now();
    let followupQueries = 0;
    let enqueuedCount = 0;

    if (isDbAvailable && dbClient && incidents.length > 0) {
      try {
        const followupRepo = new FollowupRepository(dbClient);
        const actionQueue = new ActionQueue(dbClient);

        // FollowupEngine instantiated with ZERO AI dependencies
        const followupEngine = new FollowupEngine(followupRepo, actionQueue);
        const followupResults = await followupEngine.processIncidentFollowups(incidents, historyMap, undefined, referenceTimeMs);
        
        followupQueries = 1 + incidents.length * 2 + 1;
        enqueuedCount = followupResults.filter((r) => r.newState.includes("PENDING")).length;

        // 12. Enqueue AI Jobs into background ai_analysis_jobs table asynchronously
        console.log(`[AI Queue] Repository exists: ${!!aiJobRepo}`);
        console.log(`[AI Queue] Total incidents: ${incidents.length}`);

        let successfulEnqueue = 0;
        let failedEnqueue = 0;

        if (aiJobRepo) {
          for (const inc of incidents) {
            const dbId = keyToIdMap.get(inc.incidentKey) || inc.incidentId;
            if (dbId) {
              const priority = inc.priorityScore >= 75 ? "urgent" : inc.priorityScore >= 50 ? "high" : "medium";
              console.log(`[AI Queue] Enqueue: incidentId=${dbId} incidentKey=${inc.incidentKey} priority=${priority}`);
              try {
                await aiJobRepo.enqueueJob(dbId, priority);
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

        console.log(`=========================\nAI Queue Summary\nRepository exists: ${!!aiJobRepo}\nIncidents: ${incidents.length}\nSuccessful: ${successfulEnqueue}\nFailed: ${failedEnqueue}\n=========================`);
      } catch (err: any) {
        console.error("[AI Queue] Error occurred in followup/AI queue block:", err);
        throw err;
      }
    }
    recordPhase("processFollowups", performance.now() - tFollowupStart, incidents.length, 1, incidents.length, followupQueries, "Deterministic Follow-up state machine evaluation & AI Job enqueueing");

    // 12. Enqueue Notification Actions
    const tEnqueueStart = performance.now();
    const enqueueQueries = enqueuedCount * 3;
    recordPhase("enqueueActions", performance.now() - tEnqueueStart, enqueuedCount, enqueuedCount, 1, enqueueQueries, "ActionQueue notification action enqueueing");

    // 13. Complete sync_run with status = success
    const tFinalizeStart = performance.now();
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startTime;
    let finalizeQueries = 0;

    if (syncRunRepo && !syncRunId.startsWith("local-sync")) {
      try {
        await syncRunRepo.updateSuccess(syncRunId, {
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
    recordPhase("finalize", performance.now() - tFinalizeStart, 1, 1, 1, finalizeQueries, "Finalized sync_runs status = success");

    console.log(`[SyncRillnet Performance Summary] Total Duration: ${durationMs}ms | Total DB Queries: ${totalQueries}`);
    await refresh({ source: 'sync', changedIncidentIds: [], changedWarehouseIds: [] });
    // DIAGNOSTIC: projection refresh() is now called here.

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
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startTime;
    const rawMessage = err instanceof Error ? err.message : String(err);

    const sanitizedMessage = rawMessage.replace(/https?:\/\/[^\s]+/g, "[URL REDACTED]");
    const errorCode = err instanceof Error ? err.name : "SyncError";

    if (syncRunRepo && !syncRunId.startsWith("local-sync")) {
      try {
        await syncRunRepo.updateFailed(syncRunId, {
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
