const fs = require('fs');

const workerCode = `
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";

export interface WorkerProcessResult {
  processedCount: number;
  completedCount: number;
  failedCount: number;
  jobs: Array<{
    jobId: string;
    incidentId: string;
    status: string;
    durationMs: number;
    error?: string;
  }>;
}

export class AiAnalysisWorker {
  constructor() {}

  /**
   * Claims and processes up to maxJobs pending AI jobs asynchronously.
   * Business logic delegates to AiWorkerService.
   */
  async processPendingJobs(
    workerId: string = \`worker-\${Math.random().toString(36).substring(2, 7)}\`,
    maxJobs: number = 5
  ): Promise<WorkerProcessResult> {
    let dbClient;
    try {
      dbClient = createAdminClient();
    } catch {
      // Fallback in-memory or degraded state
      // ServiceFactory requires client, so if it fails, we return a failed summary
      return {
        processedCount: 0,
        completedCount: 0,
        failedCount: 1,
        jobs: [{
          jobId: "unknown",
          incidentId: "unknown",
          status: "FAILED",
          durationMs: 0,
          error: "Database client initialization failed"
        }]
      };
    }

    try {
      const aiWorkerService = ServiceFactory.getAiWorkerService(dbClient);
      const result = await aiWorkerService.processPendingJobs(workerId, maxJobs);
      return result;
    } catch (err: unknown) {
      console.error("[AiAnalysisWorker] Critical error processing jobs:", err);
      return {
        processedCount: 0,
        completedCount: 0,
        failedCount: 1,
        jobs: [{
          jobId: "unknown",
          incidentId: "unknown",
          status: "FAILED",
          durationMs: 0,
          error: err instanceof Error ? err.message : String(err)
        }]
      };
    }
  }
}
`;

fs.writeFileSync('src/jobs/ai-analysis-worker.ts', workerCode.trim() + '\n');
