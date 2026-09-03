import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";
import { AIWorkflowService } from "@/workflow/AIWorkflowService";
import { logger } from '@/observability/logger';
import { ErrorCode } from '@/observability/errorCodes';
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
    workerId: string = `worker-${Math.random().toString(36).substring(2, 7)}`,
    maxJobs: number = 5,
    incidentId?: string
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
      const result = await aiWorkerService.processPendingJobs(workerId, maxJobs, incidentId);

      // New orchestration: run AIWorkflowService for each incident returned.
      for (const job of result.jobs) {
        if (job.status !== "COMPLETED") continue;
        try {
          const workflow = new AIWorkflowService(undefined, dbClient);
          const wfResult = await workflow.execute(job.incidentId);
          logger.info({
            component: 'AiAnalysisWorker',
            operation: 'runWorkflow',
            incidentId: job.incidentId,
            workflowId: wfResult.workflowId,
            finalState: wfResult.state,
          });
        } catch (wfErr: unknown) {
          logger.error({
            component: 'AiAnalysisWorker',
            operation: 'runWorkflow',
            incidentId: job.incidentId,
            status: 'error',
            message: '[AiAnalysisWorker] Workflow execution failed',
            errorCode: ErrorCode.AI_WORKFLOW_FAILED,
            error: wfErr instanceof Error ? wfErr : new Error(String(wfErr)),
          });
        }
      }

      return result;
    }
    catch (err: unknown) {
      logger.error({
        component: "AiAnalysisWorker",
        operation: "processPendingJobs",
        status: "error",
        message: "[AiAnalysisWorker] Critical error processing jobs",
        errorCode: ErrorCode.AI_JOB_PROCESSING_FAILED,
        error: err instanceof Error ? err : new Error(String(err)),
        metadata: {}
      });
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
