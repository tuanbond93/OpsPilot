import { RillnetConnector } from "@/connectors/rillnet";
import { aggregateIncidents, inspectOrderForIncident, REASON_CODE_MAP } from "@/engine/incident";
import {
  createAdminClient,
  SyncRunRepository,
  OrderSnapshotRepository,
  IncidentRepository,
  IncidentHistoryRepository,
  ExceptionRepository,
  FollowupRepository,
  type OrderSnapshotRow,
} from "@/connectors/supabase";
import { FollowupEngine } from "@/engine/followup";

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
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Runs complete Rillnet sync and persistence workflow
 */
export async function syncRillnet(): Promise<SyncJobResult> {
  const startTime = Date.now();
  const startedAt = new Date(startTime).toISOString();

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

  if (isDbAvailable && dbClient) {
    syncRunRepo = new SyncRunRepository(dbClient);
    orderSnapshotRepo = new OrderSnapshotRepository(dbClient);
    incidentRepo = new IncidentRepository(dbClient);
    incidentHistoryRepo = new IncidentHistoryRepository(dbClient);
    exceptionRepo = new ExceptionRepository(dbClient);
  }

  // 1. Create sync_runs row (status = running)
  let syncRunId = `local-sync-${Date.now()}`;
  if (syncRunRepo) {
    try {
      const syncRunRow = await syncRunRepo.createSyncRun(startedAt);
      syncRunId = syncRunRow.id;
    } catch {
      // Fallback local ID if DB table not yet migrated
    }
  }

  try {
    // 2. Fetch Rillnet snapshot
    const connector = new RillnetConnector();
    const snapshotResult = await connector.fetchSnapshot();
    const fetchedOrderCount = snapshotResult.totalOrders;
    const normalizedOrderCount = snapshotResult.orders.length;
    const sourceUpdatedAt = snapshotResult.fetchedAt;

    // 3. Load active, non-expired exceptions
    let activeExceptions = new Set<string>();
    if (exceptionRepo) {
      try {
        activeExceptions = await exceptionRepo.getActiveExceptionOrderCodes(startedAt);
      } catch {
        // Fallback to empty exceptions
      }
    }

    // 4. Apply Rule Engine with active exceptions
    const referenceTimeMs = new Date(sourceUpdatedAt).getTime() || startTime;
    const incidents = aggregateIncidents(
      snapshotResult.orders,
      undefined,
      referenceTimeMs,
      activeExceptions
    );
    const incidentCount = incidents.length;

    // 5. Save order snapshots in batches (batch size: 500)
    if (orderSnapshotRepo && syncRunId && !syncRunId.startsWith("local-sync")) {
      try {
        // Save all incident-affected order snapshots (with reason_code and age_hours)
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

        await orderSnapshotRepo.insertBatch(snapshotRows, 500);
      } catch {
        // Suppress batch save errors in local test modes
      }
    }

    // 6. Upsert current incidents using stable incident_key
    let resolvedIncidentCount = 0;
    if (incidentRepo && incidentHistoryRepo && syncRunId && !syncRunId.startsWith("local-sync")) {
      try {
        const savedIncidentRows = await incidentRepo.upsertIncidents(incidents, syncRunId);
        
        // Build incident_key -> DB UUID map
        const keyToIdMap = new Map<string, string>();
        for (const row of savedIncidentRows) {
          keyToIdMap.set(row.incident_key, row.id);
        }

        // 7. Insert incident_history rows (max 5 sample order codes)
        await incidentHistoryRepo.insertHistoryRecords(
          keyToIdMap,
          incidents,
          syncRunId,
          startedAt
        );

        // 8. Resolve absent incidents from previous run
        const activeKeys = incidents.map((inc) => inc.incidentKey);
        resolvedIncidentCount = await incidentRepo.resolveAbsentIncidents(
          activeKeys,
          syncRunId,
          startedAt
        );

        // 9. Execute Follow-up Engine State Machine using UUID FKs
        try {
          const followupRepo = dbClient ? new FollowupRepository(dbClient) : null;
          const incidentDbIds: string[] = [];

          for (const inc of incidents) {
            const dbId = keyToIdMap.get(inc.incidentKey);
            if (dbId) {
              inc.incidentId = dbId; // Assign DB UUID FK
              incidentDbIds.push(dbId);
            }
          }

          // 1 Single Database Query for all incident histories (No N+1!)
          const historyMap = await incidentHistoryRepo.getHistoriesByIncidentIds(incidentDbIds);

          const followupEngine = new FollowupEngine(followupRepo);
          await followupEngine.processIncidentFollowups(incidents, historyMap, undefined, referenceTimeMs);
        } catch {
          // Suppress followup engine errors in background sync
        }
      } catch {
        // Suppress DB upsert errors if DB is unreachable
      }
    }

    // 9. Complete sync_run with status = success
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startTime;

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
      } catch {
        // Fallback
      }
    }

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
    };
  } catch (err: unknown) {
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startTime;
    const rawMessage = err instanceof Error ? err.message : String(err);

    // Sanitize error message (remove potential secret tokens / URLs)
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
      error: {
        code: errorCode,
        message: sanitizedMessage,
      },
    };
  }
}
