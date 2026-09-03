import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiAnalysisJobRow, AiJobPriority, AiJobStatus } from "@/connectors/supabase/types";
import { BaseRepository } from "../base/BaseRepository";
import type { IAiJobRepository } from "../interfaces/IAiJobRepository";
import { logger } from "@/observability/logger";

export class SupabaseAiJobRepository extends BaseRepository implements IAiJobRepository {
  constructor(client: SupabaseClient) {
    super(client);
  }

  async enqueueJob(
    incidentId: string,
    priority: AiJobPriority = "medium",
    scheduledAt: string = new Date().toISOString()
  ): Promise<AiAnalysisJobRow> {
    const existing = await this.getPendingJobByIncidentId(incidentId);
    if (existing) {
      logger.info({
        component: "SupabaseAiJobRepository",
        operation: "enqueueJob",
        status: "existing",
        message: `[AIJobRepo] existing job found id=${existing.id} status=${existing.status}`,
        metadata: {
          jobId: existing.id,
          incidentId,
          jobStatus: existing.status,
        },
      });
      return existing;
    }

    const newJobPayload: Partial<AiAnalysisJobRow> = {
      incident_id: incidentId,
      priority,
      status: "PENDING",
      attempt_count: 0,
      max_attempts: 3,
      scheduled_at: scheduledAt,
      created_at: scheduledAt,
      updated_at: scheduledAt,
    };

    const { data, error } = await this.client
      .from("ai_analysis_jobs")
      .insert([newJobPayload])
      .select()
      .single();

    if (error) {
      logger.error({
        component: "SupabaseAiJobRepository",
        operation: "enqueueJob",
        status: "failed",
        message: `[AIJobRepo] insert error: ${error.message}`,
        errorCode: "AI_JOB_PROCESSING_FAILED",
        error,
        metadata: {
          incidentId,
          priority,
        },
      });
      throw error;
    }
    if (!data) {
      throw new Error("No data returned from enqueueJob insertion");
    }

    logger.info({
      component: "SupabaseAiJobRepository",
      operation: "enqueueJob",
      status: "success",
      message: `[AIJobRepo] enqueued job id=${data.id}`,
      metadata: {
        jobId: data.id,
        incidentId,
        priority,
      },
    });

    return data;
  }

  async claimPendingJob(
    workerId: string,
    lockTimeoutMs: number = 300000 // 5 minutes
  ): Promise<AiAnalysisJobRow | null> {
    const nowIso = new Date().toISOString();
    const staleLockThreshold = new Date(Date.now() - lockTimeoutMs).toISOString();

    const { data: candidates, error: findError } = await this.client
      .from("ai_analysis_jobs")
      .select("*")
      .or(`status.eq.PENDING,and(status.eq.PROCESSING,locked_at.lt.${staleLockThreshold})`)
      .lte("scheduled_at", nowIso)
      .order("priority", { ascending: false })
      .order("scheduled_at", { ascending: true })
      .limit(1);

    if (findError) throw findError;

    if (candidates && candidates.length > 0) {
      const candidate = candidates[0];
      const { data: claimed, error: updateError } = await this.client
        .from("ai_analysis_jobs")
        .update({
          status: "PROCESSING",
          worker_id: workerId,
          locked_at: nowIso,
          started_at: candidate.started_at || nowIso,
          updated_at: nowIso,
        })
        .eq("id", candidate.id)
        .eq("status", candidate.status)
        .select()
        .maybeSingle();

      if (updateError) throw updateError;
      return claimed;
    }

    return null;
  }

  async claimPendingJobForIncident(
    workerId: string,
    incidentId: string,
    lockTimeoutMs: number = 300000
  ): Promise<AiAnalysisJobRow | null> {
    const nowIso = new Date().toISOString();
    const staleLockThreshold = new Date(Date.now() - lockTimeoutMs).toISOString();
    const { data: candidates, error: findError } = await this.client
      .from("ai_analysis_jobs")
      .select("*")
      .eq("incident_id", incidentId)
      .or(`status.eq.PENDING,and(status.eq.PROCESSING,locked_at.lt.${staleLockThreshold})`)
      .lte("scheduled_at", nowIso)
      .order("scheduled_at", { ascending: true })
      .limit(1);
    if (findError) throw findError;
    const candidate = candidates?.[0];
    if (!candidate) return null;
    const { data: claimed, error: updateError } = await this.client
      .from("ai_analysis_jobs")
      .update({ status: "PROCESSING", worker_id: workerId, locked_at: nowIso, started_at: candidate.started_at || nowIso, updated_at: nowIso })
      .eq("id", candidate.id)
      .eq("status", candidate.status)
      .select()
      .maybeSingle();
    if (updateError) throw updateError;
    return claimed;
  }

  async markJobCompleted(jobId: string): Promise<AiAnalysisJobRow | null> {
    const nowIso = new Date().toISOString();

    const query = this.client
      .from("ai_analysis_jobs")
      .update({
        status: "COMPLETED",
        completed_at: nowIso,
        locked_at: null,
        worker_id: null,
        updated_at: nowIso,
      })
      .eq("id", jobId)
      .select()
      .maybeSingle();

    return this.executeOptional<AiAnalysisJobRow>(query as any);
  }

  async markJobFailed(
    jobId: string,
    errorMsg: string,
    retryDelaySeconds: number = 60,
    permanent: boolean = false
  ): Promise<AiAnalysisJobRow | null> {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const { data: job, error: getError } = await this.client
      .from("ai_analysis_jobs")
      .select("attempt_count, max_attempts")
      .eq("id", jobId)
      .maybeSingle();

    if (getError) throw getError;

    const attempts = (job?.attempt_count || 0) + 1;
    const maxAttempts = job?.max_attempts || 3;
    const isFailedPermanently = permanent || attempts >= maxAttempts;

    const nextStatus: AiJobStatus = isFailedPermanently ? "FAILED" : "PENDING";
    const nextScheduledAt = isFailedPermanently
      ? nowIso
      : new Date(now + retryDelaySeconds * 1000).toISOString();

    const query = this.client
      .from("ai_analysis_jobs")
      .update({
        status: nextStatus,
        attempt_count: attempts,
        scheduled_at: nextScheduledAt,
        last_error: errorMsg,
        locked_at: null,
        worker_id: null,
        updated_at: nowIso,
      })
      .eq("id", jobId)
      .select()
      .maybeSingle();

    return this.executeOptional<AiAnalysisJobRow>(query as any);
  }

  async getPendingJobByIncidentId(incidentId: string): Promise<AiAnalysisJobRow | null> {
    const query = this.client
      .from("ai_analysis_jobs")
      .select("*")
      .eq("incident_id", incidentId)
      .in("status", ["PENDING", "PROCESSING"])
      .limit(1)
      .maybeSingle();

    return this.executeOptional<AiAnalysisJobRow>(query as any);
  }

  async getAllJobs(limit: number = 100): Promise<AiAnalysisJobRow[]> {
    const query = this.client
      .from("ai_analysis_jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    return this.executeMany<AiAnalysisJobRow>(query as any);
  }

  async getLatestJobByIncidentId(incidentId: string): Promise<AiAnalysisJobRow | null> {
    const query = this.client
      .from("ai_analysis_jobs")
      .select("*")
      .eq("incident_id", incidentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return this.executeOptional<AiAnalysisJobRow>(query as any);
  }
}
