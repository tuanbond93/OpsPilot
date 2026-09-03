import type { AiAnalysisJobRow, AiJobPriority } from "@/connectors/supabase/types";

export interface IAiJobRepository {
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
  getLatestJobByIncidentId(incidentId: string): Promise<AiAnalysisJobRow | null>;
}
