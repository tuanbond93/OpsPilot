
import type { IAiWorkerService } from "../interfaces/IAiWorkerService";
import type { IAiJobRepository } from "../../repositories/interfaces/IAiJobRepository";
import type { IIncidentRepository } from "../../repositories/interfaces/IIncidentRepository";
import type { IFollowupRepository } from "../../repositories/interfaces/IFollowupRepository";
import type { IPlannerRepository } from "../../repositories/interfaces/IPlannerRepository";
import type { RootCauseAgent } from "../../agents/root-cause";
import type { ActionPlannerAgent } from "../../agents/action-planner";
import type { Incident, IncidentReasonCode } from "../../engine/incident";

import type { IIncidentHistoryRepository } from "../../repositories/interfaces/IIncidentHistoryRepository";
import type { IExceptionRepository } from "../../repositories/interfaces/IExceptionRepository";
import type { IDecisionPilotService } from "../interfaces/IDecisionPilotService";
import { createHash } from "node:crypto";

export class AiWorkerService implements IAiWorkerService {
  constructor(
    private aiJobRepo: IAiJobRepository,
    private incidentRepo: IIncidentRepository,
    private historyRepo: IIncidentHistoryRepository,
    private followupRepo: IFollowupRepository,
    private plannerRepo: IPlannerRepository,
    private exceptionRepo: IExceptionRepository,
    private rootCauseAgent: RootCauseAgent,
    private actionPlannerAgent: ActionPlannerAgent,
    private decisionPilotService?: IDecisionPilotService
  ) {}

  async enqueueJob(jobData: any): Promise<void> {
    throw new Error("Not implemented yet: AiWorkerService.enqueueJob");
  }

  async processPendingJobs(
    workerId: string = `worker-${Math.random().toString(36).substring(2, 7)}`,
    maxJobs: number = 5,
    incidentId?: string
  ): Promise<any> {
    const result = {
      processedCount: 0,
      completedCount: 0,
      failedCount: 0,
      jobs: [] as any[],
    };

    for (let i = 0; i < maxJobs; i++) {
      const job = incidentId
        ? await this.aiJobRepo.claimPendingJobForIncident(workerId, incidentId)
        : await this.aiJobRepo.claimPendingJob(workerId);
      if (!job) break;

      result.processedCount++;
      const jobStart = Date.now();

      try {
        // 1. Load Incident
        const incidentRow = await this.incidentRepo.getIncidentById(job.incident_id);
        if (!incidentRow) {
          throw new Error(`Incident not found for ID: ${job.incident_id}`);
        }

        // 2. Load History
        const histMap = await this.historyRepo.getHistoriesByIncidentIds([incidentRow.id]);
        const historyRows = histMap.get(incidentRow.id) || [];
        const latestHist = historyRows[0];

        const incident: Incident = {
          incidentId: incidentRow.id,
          incidentKey: incidentRow.incident_key,
          warehouseId: incidentRow.warehouse_id || "",
          warehouseName: incidentRow.warehouse_name || "",
          reasonCode: incidentRow.reason_code as IncidentReasonCode,
          reasonName: incidentRow.reason_name,
          affectedOrderCount: latestHist ? latestHist.affected_order_count : 0,
          sampleOrderCodes: latestHist?.sample_order_codes || [],
          averageAgeHours: latestHist?.average_age_hours || 0,
          maximumAgeHours: latestHist?.maximum_age_hours || 0,
          oldestOrderCode: latestHist?.oldest_order_code || latestHist?.sample_order_codes?.[0] || null,
          priorityScore: incidentRow.priority_score || 0,
          firstDetectedAt: incidentRow.first_detected_at,
          lastDetectedAt: incidentRow.last_detected_at,
          status: incidentRow.status,
        };

        // 3. Load Followup Case & Exceptions
        const cases = await this.followupRepo.getCasesByIncidentKeys([incidentRow.incident_key]);
        const followupCase = cases[0] || null;

        let activeExceptions: any[] = [];
        try {
          const exceptionCodes = await this.exceptionRepo.getActiveExceptionOrderCodes(new Date().toISOString());
          activeExceptions = Array.from(exceptionCodes).map((code) => ({
            order_code: code,
            reason_code: incidentRow.reason_code,
            expires_at: null,
          }));
        } catch {
          // Fallback
        }

        // 4. Run Root Cause Agent (Cache-aware)
        const rcResponse = await this.rootCauseAgent.analyzeIncident(incident, historyRows);

        // 5. Run Action Planner Agent (reads persisted Root Cause)
        const plannerResponse = await this.actionPlannerAgent.analyzeIncident({
          incident: incidentRow,
          historyRows,
          rootCauseResult: rcResponse.analysis,
          followupCase,
          activeExceptions,
        });

        // The decision lane must read its evidence back from storage, never
        // from this worker's memory. ActionPlanner retains backward-compatible
        // best-effort writes, so make the Level C persistence contract explicit
        // here and fail this job if it cannot be satisfied.
        const persistedResult = {
          ...plannerResponse.result,
          rootCauseSummary: rcResponse.analysis.summary,
          rootCause: rcResponse.analysis as unknown as Record<string, unknown>,
        };
        // Older ActionPlanner runs intentionally swallow a persistence failure
        // to keep Lane A operational. Level C cannot do that: create its own
        // evidence-bearing run when the legacy best-effort write yielded none.
        const plannerRunId = plannerResponse.runId || (await this.plannerRepo.createPlannerRun({
          incident_id: incidentRow.id,
          followup_case_id: followupCase?.id || null,
          status: "DRAFT",
          context_hash: createHash("sha256").update(`level-c:${job.id}`).digest("hex"),
          prompt_version: 1,
          provider: String(plannerResponse.result.metadata?.provider || "level_c_worker").slice(0, 50),
          model: String(plannerResponse.result.metadata?.model || "unknown").slice(0, 50),
          result: persistedResult,
        })).id;
        const persistedPlanner = await this.plannerRepo.getPlannerRunById(plannerRunId);
        if (!persistedPlanner) {
          throw new Error("PERSISTED_PLANNER_REQUIRED: planner run cannot be read back");
        }
        const updatedPlanner = await this.plannerRepo.updatePlannerRunResult(plannerRunId, {
          ...(persistedPlanner.result || {}),
          ...persistedResult,
        });
        if (!updatedPlanner) {
          throw new Error("PERSISTED_ROOT_CAUSE_REQUIRED: root cause could not be persisted with planner run");
        }

        // LC-C1 hand-off is intentionally after persisted root-cause and
        // planner output. DecisionPilot independently requires the latest
        // persisted AI_DECISION_REQUIRED triage, therefore routine Lane A
        // jobs cannot enter the Telegram manager-decision lane.
        const shadowResult = this.decisionPilotService
          ? await this.decisionPilotService.createShadowFromIncident({
              incidentId: incidentRow.id,
              actor: `ai-worker:${workerId}`,
              idempotencyKey: `ai-shadow:${job.id}`,
            })
          : null;

        // 6. Mark Completed
        await this.aiJobRepo.markJobCompleted(job.id);
        result.completedCount++;
        result.jobs.push({
          jobId: job.id,
          incidentId: job.incident_id,
          status: "COMPLETED",
          durationMs: Date.now() - jobStart,
          decisionShadow: shadowResult?.ok
            ? "CREATED"
            : shadowResult
              ? `NOT_CREATED:${shadowResult.error || "BLOCKED"}`
              : "NOT_CONFIGURED",
        });
      } catch (err: unknown) {
        result.failedCount++;
        const rawMsg = err instanceof Error ? err.message : String(err);
        const isPermanent =
          rawMsg.includes("401") ||
          rawMsg.includes("403") ||
          rawMsg.includes("404") ||
          rawMsg.includes("schema") ||
          rawMsg.includes("Incident not found");

        const delay = job.attempt_count === 0 ? 30 : job.attempt_count === 1 ? 60 : 120;
        await this.aiJobRepo.markJobFailed(job.id, rawMsg, delay, isPermanent);

        result.jobs.push({
          jobId: job.id,
          incidentId: job.incident_id,
          status: "FAILED",
          durationMs: Date.now() - jobStart,
          error: rawMsg,
        });
      }
    }

    return result;
  }
}
