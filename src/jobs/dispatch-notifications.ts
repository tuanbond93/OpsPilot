import { createAdminClient } from "../connectors/supabase";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";
import type { DispatchSummary } from "@/services/interfaces/INotificationService";
import { ServiceFactory } from "@/services/ServiceFactory";

export interface DispatchJobResult {
  ok: boolean;
  timestamp: string;
  summary: DispatchSummary;
  error?: string;
}

/**
  Independent Notification Dispatcher background job.
 * Dispatches due pending actions, claims them atomically, handles retries & state confirmation.
 */
export async function runNotificationDispatcherJob(
  workerId: string = "cron-worker-1",
  referenceTimeMs: number = Date.now()
): Promise<DispatchJobResult> {
  const timestamp = new Date(referenceTimeMs).toISOString();

  try {
    const dbClient = createAdminClient();
    const notifService = ServiceFactory.getNotificationService(dbClient);
    const summary = await notifService.dispatchPending(workerId, referenceTimeMs);

    return {
      ok: true,
      timestamp,
      summary,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      timestamp,
      summary: {
        claimedCount: 0,
        sentCount: 0,
        simulatedCount: 0,
        failedCount: 0,
        retriedCount: 0,
      },
      error,
    };
  }
}
