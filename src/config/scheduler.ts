import { syncRillnet } from "../jobs/sync-rillnet";
import { AiAnalysisWorker } from "../jobs/ai-analysis-worker";
import { runNotificationDispatcherJob } from "../jobs/dispatch-notifications";
import type { DeclarativeJob } from "../integrations/scheduler";

export const SCHEDULER_JOBS: DeclarativeJob[] = [
  {
    name: "sync-rillnet",
    description: "Fetch external Rillnet order snapshot, normalize exceptions, and upsert incidents",
    schedule: "*/5 * * * *", // every 5 minutes
    enabled: true,
    handler: async () => {
      const res = await syncRillnet();
      return {
        success: res.ok,
        details: `Processed ${res.fetchedOrderCount} orders, detected ${res.incidentCount} incidents. Duration: ${res.durationMs}ms`,
        error: res.error?.message,
      };
    },
  },
  {
    name: "process-ai-jobs",
    description: "AI Worker atomic processing queue for incident root cause and planner recommendation drafts",
    schedule: "* * * * *", // every minute
    enabled: true,
    handler: async () => {
      const worker = new AiAnalysisWorker();
      const res = await worker.processPendingJobs(`worker-cron-${Date.now().toString(36)}`, 5);
      return {
        success: res.failedCount === 0,
        details: `Processed: ${res.processedCount}, Completed: ${res.completedCount}, Failed: ${res.failedCount}`,
        error: res.failedCount > 0 ? "Some AI worker jobs failed" : undefined,
      };
    },
  },
  {
    name: "dispatch-notifications",
    description: "Independent platform dispatcher running notification claims and Telegram deliveries",
    schedule: "*/2 * * * *", // every 2 minutes
    enabled: true,
    handler: async () => {
      const res = await runNotificationDispatcherJob(`dispatcher-cron-${Date.now().toString(36)}`);
      return {
        success: res.ok,
        details: `Claimed: ${res.summary.claimedCount}, Sent: ${res.summary.sentCount}, Simulated: ${res.summary.simulatedCount}, Failed: ${res.summary.failedCount}`,
        error: res.error,
      };
    },
  },
];
