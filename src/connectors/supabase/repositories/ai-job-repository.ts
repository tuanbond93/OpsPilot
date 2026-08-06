import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiAnalysisJobRow, AiJobPriority, AiJobStatus } from "../types";
import { isFallbackAllowed } from "../fallback-policy";

export class AiJobRepository {
  private inMemoryJobs: AiAnalysisJobRow[] = [];

  constructor(private client?: SupabaseClient | null) {}

  clearMemory(): void {
    this.inMemoryJobs = [];
  }

  async enqueueJob(
    incidentId: string,
    priority: AiJobPriority = "medium",
    scheduledAt: string = new Date().toISOString()
  ): Promise<AiAnalysisJobRow> {
    // Return existing PENDING / PROCESSING job if found
    console.log(`[AIJobRepo] checking existing job incidentId=${incidentId}`);
    const existing = await this.getPendingJobByIncidentId(incidentId);
    if (existing) {
      console.log(`[AIJobRepo] existing job found id=${existing.id} status=${existing.status}`);
      console.log("[AIJobRepo] returning EXISTING row");
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

    if (this.client) {
      try {
        console.log("[AIJobRepo] inserting new job...");
        const { data, error } = await this.client
          .from("ai_analysis_jobs")
          .insert([newJobPayload])
          .select()
          .single();

        console.log(`[AIJobRepo] insert result\ndata=${data ? JSON.stringify(data) : "null"}\nerror=${error ? JSON.stringify(error) : "null"}`);

        if (!error && data) {
          console.log("[AIJobRepo] returning DATABASE row");
          return data;
        }
        if (!isFallbackAllowed()) throw error || new Error("enqueueJob failed");
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
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
    console.log("[AIJobRepo] returning MEMORY fallback");
    return fullJob;
  }

  async claimPendingJob(
    workerId: string,
    lockTimeoutMs: number = 300000 // 5 minutes
  ): Promise<AiAnalysisJobRow | null> {
    const nowIso = new Date().toISOString();
    const staleLockThreshold = new Date(Date.now() - lockTimeoutMs).toISOString();

    if (this.client) {
      try {
        const { data: candidates, error: findError } = await this.client
          .from("ai_analysis_jobs")
          .select("*")
          .or(`status.eq.PENDING,and(status.eq.PROCESSING,locked_at.lt.${staleLockThreshold})`)
          .lte("scheduled_at", nowIso)
          .order("priority", { ascending: false })
          .order("scheduled_at", { ascending: true })
          .limit(1);

        if (!findError && candidates && candidates.length > 0) {
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

          if (!updateError && claimed) return claimed;
        }
        if (!isFallbackAllowed() && findError) throw findError;
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

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

  async markJobCompleted(jobId: string): Promise<AiAnalysisJobRow | null> {
    const nowIso = new Date().toISOString();

    if (this.client) {
      try {
        const { data, error } = await this.client
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

        if (!error && data) return data;
        if (!isFallbackAllowed() && error) throw error;
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

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

    if (this.client) {
      try {
        const { data: job } = await this.client
          .from("ai_analysis_jobs")
          .select("attempt_count, max_attempts")
          .eq("id", jobId)
          .maybeSingle();

        const attempts = (job?.attempt_count || 0) + 1;
        const maxAttempts = job?.max_attempts || 3;
        const isFailedPermanently = permanent || attempts >= maxAttempts;

        const nextStatus: AiJobStatus = isFailedPermanently ? "FAILED" : "PENDING";
        const nextScheduledAt = isFailedPermanently
          ? nowIso
          : new Date(now + retryDelaySeconds * 1000).toISOString();

        const { data, error } = await this.client
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

        if (!error && data) return data;
        if (!isFallbackAllowed() && error) throw error;
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

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
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("ai_analysis_jobs")
          .select("*")
          .eq("incident_id", incidentId)
          .in("status", ["PENDING", "PROCESSING"])
          .limit(1)
          .maybeSingle();

        if (!error && data) return data;
        if (!isFallbackAllowed() && error) throw error;
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    return (
      this.inMemoryJobs.find(
        (j) => j.incident_id === incidentId && (j.status === "PENDING" || j.status === "PROCESSING")
      ) || null
    );
  }

  async getAllJobs(limit: number = 100): Promise<AiAnalysisJobRow[]> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("ai_analysis_jobs")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(limit);

        if (!error && data) return data;
        if (!isFallbackAllowed()) throw error || new Error("getAllJobs failed");
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    return [...this.inMemoryJobs]
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      .slice(0, limit);
  }

  async getLatestJobByIncidentId(incidentId: string): Promise<AiAnalysisJobRow | null> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("ai_analysis_jobs")
          .select("*")
          .eq("incident_id", incidentId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!error && data) return data;
        if (!isFallbackAllowed() && error) throw error;
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    const matches = this.inMemoryJobs.filter((j) => j.incident_id === incidentId);
    return matches.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())[0] || null;
  }
}
