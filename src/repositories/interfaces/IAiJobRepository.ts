import type { AiAnalysisJobRow, AiJobPriority } from "@/connectors/supabase/types";

export type AiRunEnqueueResult = {
  eligibleCount: number;
  alreadyLinkedCount: number;
  reusedCount: number;
  createdCount: number;
};

export interface IAiJobRepository {
  enqueueEligibleForSyncRun(syncRunId: string): Promise<AiRunEnqueueResult>;
  enqueueJob(
    incidentId: string,
    priority?: AiJobPriority,
    scheduledAt?: string
  ): Promise<AiAnalysisJobRow>;
  claimPendingJob(workerId: string, lockTimeoutMs?: number): Promise<AiAnalysisJobRow | null>;
  claimPendingJobForIncident(workerId: string, incidentId: string, lockTimeoutMs?: number): Promise<AiAnalysisJobRow | null>;
  markJobCompleted(jobId: string): Promise<AiAnalysisJobRow | null>;
  markJobFailed(
    jobId: string,
    errorMsg: string,
    retryDelaySeconds?: number,
    permanent?: boolean
  ): Promise<AiAnalysisJobRow | null>;
  getPendingJobByIncidentId(incidentId: string): Promise<AiAnalysisJobRow | null>;
  getAllJobs(limit?: number): Promise<AiAnalysisJobRow[]>;
  getDashboardJobs(sinceIso: string, limit?: number): Promise<AiAnalysisJobRow[]>;
  getLatestJobByIncidentId(incidentId: string): Promise<AiAnalysisJobRow | null>;
}
