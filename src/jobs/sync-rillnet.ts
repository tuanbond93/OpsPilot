import { createAdminClient } from "../connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";

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
 * Runs complete Rillnet sync and persistence workflow by delegating to SyncService via ServiceFactory.
 * ZERO AI executions or external LLM calls occur during sync.
 */
export async function syncRillnet(): Promise<SyncJobResult> {
  let dbClient;
  try {
    dbClient = createAdminClient();
  } catch {
    // Uninitialized/fallback dbClient
  }

  const syncService = ServiceFactory.getSyncService(dbClient);
  return syncService.runSync();
}
