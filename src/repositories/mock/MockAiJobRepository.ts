import type { AiAnalysisJobRow, AiJobPriority, AiJobStatus } from "@/connectors/supabase/types";
import type { IAiJobRepository } from "../interfaces/IAiJobRepository";
import { logger } from "@/observability/logger";

export class MockAiJobRepository implements IAiJobRepository {
  private inMemoryJobs: AiAnalysisJobRow[] = [];

  clearMemory(): void {
    this.inMemoryJobs = [];
  }

  seed(jobs: AiAnalysisJobRow[]): void {
    this.inMemoryJobs = [...jobs];
  }

  async enqueueJob(
    incidentId: string,
    priority: AiJobPriority = "medium",
    scheduledAt: string = new Date().toISOString()
  ): Promise<AiAnalysisJobRow> {
    logger.info({
      component: "MockAiJobRepository",
      operation: "enqueueJob",
      status: "checking",
      message: `[AIJobRepo] checking existing job incidentId=${incidentId}`,
      metadata: { incidentId },
    });
    const existing = await this.getPendingJobByIncidentId(incidentId);
    if (existing) {
      logger.info({
        component: "MockAiJobRepository",
        operation: "enqueueJob",
        status: "existing",
        message: `[AIJobRepo] existing job found id=${existing.id} status=${existing.status}`,
        metadata: { jobId: existing.id, incidentId, jobStatus: existing.status },
      });
      return existing;
    }

    const fullJob: AiAnalysisJobRow = {
      id: `aijob-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      incident_id: incidentId,
      priority,
      status: "PENDING",
      attempt_count: 0,
      max_attempts: 3,
      scheduled_at: scheduledAt,
      started_at: null,
      completed_at: null,
      locked_at: null,
      worker_id: null,
      last_error: null,
      created_at: scheduledAt,
      updated_at: scheduledAt,
    };

    this.inMemoryJobs.push(fullJob);
    logger.info({
      component: "MockAiJobRepository",
      operation: "enqueueJob",
      status: "created",
      message: "[AIJobRepo] returning MEMORY fallback",
      metadata: { jobId: fullJob.id, incidentId },
    });
    return fullJob;
  }

  async claimPendingJob(
    workerId: string,
    lockTimeoutMs: number = 300000 // 5 minutes
  ): Promise<AiAnalysisJobRow | null> {
    const nowIso = new Date().toISOString();
    const staleLockThreshold = new Date(Date.now() - lockTimeoutMs).toISOString();

    const candidate = this.inMemoryJobs.find(
      (j) =>
        (j.status === "PENDING" || (j.status === "PROCESSING" && j.locked_at && j.locked_at < staleLockThreshold)) &&
        j.scheduled_at <= nowIso
    );

    if (!candidate) return null;

    candidate.status = "PROCESSING";
    candidate.worker_id = workerId;
    candidate.locked_at = nowIso;
    candidate.started_at = candidate.started_at || nowIso;
    candidate.updated_at = nowIso;

    return candidate;
  }

  async claimPendingJobForIncident(workerId: string, incidentId: string, lockTimeoutMs: number = 300000): Promise<AiAnalysisJobRow | null> {
    const nowIso = new Date().toISOString();
    const staleLockThreshold = new Date(Date.now() - lockTimeoutMs).toISOString();
    const candidate = this.inMemoryJobs.find((job) =>
      job.incident_id === incidentId &&
      (job.status === "PENDING" || (job.status === "PROCESSING" && job.locked_at && job.locked_at < staleLockThreshold)) &&
      job.scheduled_at <= nowIso
    );
    if (!candidate) return null;
    candidate.status = "PROCESSING";
    candidate.worker_id = workerId;
    candidate.locked_at = nowIso;
    candidate.started_at = candidate.started_at || nowIso;
    candidate.updated_at = nowIso;
    return candidate;
  }

  async markJobCompleted(jobId: string): Promise<AiAnalysisJobRow | null> {
    const nowIso = new Date().toISOString();
    const job = this.inMemoryJobs.find((j) => j.id === jobId);
    if (!job) return null;

    job.status = "COMPLETED";
    job.completed_at = nowIso;
    job.locked_at = null;
    job.worker_id = null;
    job.updated_at = nowIso;

    return job;
  }

  async markJobFailed(
    jobId: string,
    errorMsg: string,
    retryDelaySeconds: number = 60,
    permanent: boolean = false
  ): Promise<AiAnalysisJobRow | null> {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const job = this.inMemoryJobs.find((j) => j.id === jobId);
    if (!job) return null;

    job.attempt_count++;
    const isFailedPermanently = permanent || job.attempt_count >= job.max_attempts;

    job.status = isFailedPermanently ? "FAILED" : "PENDING";
    job.scheduled_at = isFailedPermanently ? nowIso : new Date(now + retryDelaySeconds * 1000).toISOString();
    job.last_error = errorMsg;
    job.locked_at = null;
    job.worker_id = null;
    job.updated_at = nowIso;

    return job;
  }

  async getPendingJobByIncidentId(incidentId: string): Promise<AiAnalysisJobRow | null> {
    return (
      this.inMemoryJobs.find(
        (j) => j.incident_id === incidentId && (j.status === "PENDING" || j.status === "PROCESSING")
      ) || null
    );
  }

  async getAllJobs(limit: number = 100): Promise<AiAnalysisJobRow[]> {
    return [...this.inMemoryJobs]
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      .slice(0, limit);
  }

  async getLatestJobByIncidentId(incidentId: string): Promise<AiAnalysisJobRow | null> {
    const matches = this.inMemoryJobs.filter((j) => j.incident_id === incidentId);
    return matches.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())[0] || null;
  }
}
