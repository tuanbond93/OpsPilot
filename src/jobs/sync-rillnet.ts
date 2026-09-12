import { createAdminClient } from "../connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";
import type { SyncOptions } from "@/services/interfaces/ISyncService";

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
  skipped?: boolean;
  skipReason?: "SOURCE_UNCHANGED" | "CHECKPOINT_ALREADY_COMPLETED";
  syncRunId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  fetchedOrderCount: number;
  normalizedOrderCount: number;
  incidentCount: number;
  followupEvaluation?: {
    supportedCasesEvaluated: number;
    khoTonEvaluated: number;
    khoChuaLuanChuyenEvaluated: number;
    pendingCreated: { first: number; second: number; third: number; escalation: number };
  };
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
  syncLockAttempts?: number;
  syncLockRetryCount?: number;
  syncLockFinalStatus?: "SUCCESS" | "NON_RETRYABLE_FAILURE" | "TRANSIENT_FAILURE" | "NOT_ATTEMPTED";
}

/**
 * Runs complete Rillnet sync and persistence workflow by delegating to SyncService via ServiceFactory.
 * ZERO AI executions or external LLM calls occur during sync.
 */
export async function syncRillnet(options?: SyncOptions): Promise<SyncJobResult> {
  let dbClient;
  try {
    dbClient = createAdminClient();
  } catch {
    // Uninitialized/fallback dbClient
  }

  const syncService = ServiceFactory.getSyncService(dbClient);
  return syncService.runSync(options);
}
