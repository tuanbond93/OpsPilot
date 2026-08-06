import { createAdminClient, FollowupRepository } from "../connectors/supabase";
import { ActionQueue } from "../engine/action-queue";
import { NotificationDispatcher, type DispatchSummary } from "../notifications";

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
    const actionQueue = new ActionQueue(dbClient);
    const followupRepo = dbClient ? new FollowupRepository(dbClient) : null;

    const dispatcher = new NotificationDispatcher(actionQueue, followupRepo, workerId);
    const summary = await dispatcher.dispatchPendingActions(referenceTimeMs);

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
