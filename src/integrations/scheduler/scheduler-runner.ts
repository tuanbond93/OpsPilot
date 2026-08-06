import type { ComponentHealth, HealthCheckable } from "../health";
import type { DeclarativeJob, JobExecutionResult } from "./types";

export class SchedulerRunner implements HealthCheckable {
  readonly name = "Scheduler";
  private static jobs = new Map<string, DeclarativeJob>();
  private static executionHistory: JobExecutionResult[] = [];
  
  private lastSuccessAt: string | null = null;
  private lastFailureAt: string | null = null;

  static register(job: DeclarativeJob): void {
    this.jobs.set(job.name.toLowerCase(), job);
  }

  static getJobs(): DeclarativeJob[] {
    return Array.from(this.jobs.values());
  }

  static getExecutionHistory(): JobExecutionResult[] {
    return this.executionHistory;
  }

  static clear(): void {
    this.jobs.clear();
    this.executionHistory = [];
  }

  /**
   * Run a specific job by name
   */
  async runJob(name: string): Promise<JobExecutionResult> {
    const jobKey = name.toLowerCase();
    const job = SchedulerRunner.jobs.get(jobKey);

    const startedAt = new Date().toISOString();
    const tStart = performance.now();

    if (!job) {
      const errRes: JobExecutionResult = {
        jobName: name,
        startedAt,
        finishedAt: startedAt,
        durationMs: 0,
        status: "FAILED",
        error: `Job '${name}' is not registered in the Job Registry.`,
      };
      SchedulerRunner.executionHistory.push(errRes);
      this.lastFailureAt = startedAt;
      return errRes;
    }

    if (!job.enabled) {
      const skippedRes: JobExecutionResult = {
        jobName: job.name,
        startedAt,
        finishedAt: startedAt,
        durationMs: 0,
        status: "SUCCESS",
        details: "Job is disabled in configuration.",
      };
      SchedulerRunner.executionHistory.push(skippedRes);
      this.lastSuccessAt = startedAt;
      return skippedRes;
    }

    try {
      const outcome = await job.handler();
      const finishedAt = new Date().toISOString();
      const durationMs = Math.round(performance.now() - tStart);

      const status = outcome.success ? "SUCCESS" : "FAILED";
      const result: JobExecutionResult = {
        jobName: job.name,
        startedAt,
        finishedAt,
        durationMs,
        status,
        details: outcome.details,
        error: outcome.error,
      };

      SchedulerRunner.executionHistory.push(result);

      if (status === "SUCCESS") {
        this.lastSuccessAt = finishedAt;
      } else {
        this.lastFailureAt = finishedAt;
      }

      // Limit history size to 100 entries
      if (SchedulerRunner.executionHistory.length > 100) {
        SchedulerRunner.executionHistory.shift();
      }

      return result;
    } catch (err: any) {
      const finishedAt = new Date().toISOString();
      const durationMs = Math.round(performance.now() - tStart);
      const errMsg = err?.message || String(err);

      const result: JobExecutionResult = {
        jobName: job.name,
        startedAt,
        finishedAt,
        durationMs,
        status: "FAILED",
        error: errMsg,
      };

      SchedulerRunner.executionHistory.push(result);
      this.lastFailureAt = finishedAt;
      return result;
    }
  }

  /**
   * Health Check Implementation
   */
  async health(): Promise<ComponentHealth> {
    const jobList = SchedulerRunner.getJobs();
    const history = SchedulerRunner.getExecutionHistory();

    const failedRuns = history.filter((h) => h.status === "FAILED");
    const activeJobs = jobList.filter((j) => j.enabled);

    if (failedRuns.length > 3) {
      return {
        status: "YELLOW",
        healthReason: `Scheduler is active but reporting ${failedRuns.length} recent job failure(s)`,
        lastSuccessAt: this.lastSuccessAt,
        lastFailureAt: this.lastFailureAt,
        freshnessSeconds: null,
      };
    }

    return {
      status: "GREEN",
      healthReason: `Scheduler online with ${activeJobs.length}/${jobList.length} enabled jobs`,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      freshnessSeconds: 0,
    };
  }
}
export const schedulerRunner = new SchedulerRunner();
