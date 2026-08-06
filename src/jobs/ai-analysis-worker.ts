import {
  createAdminClient,
  AiJobRepository,
  IncidentRepository,
  IncidentHistoryRepository,
  FollowupRepository,
  PlannerRepository,
  ExceptionRepository,
  type FollowupCaseRow,
  type IncidentHistoryRow,
} from "@/connectors/supabase";
import { RootCauseAgent } from "../agents/root-cause";
import { ActionPlannerAgent } from "../agents/action-planner";
import type { Incident, IncidentReasonCode } from "../engine/incident";

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
  constructor(
    private aiJobRepo?: AiJobRepository | null,
    private incidentRepo?: IncidentRepository | null,
    private historyRepo?: IncidentHistoryRepository | null,
    private followupRepo?: FollowupRepository | null,
    private plannerRepo?: PlannerRepository | null,
    private exceptionRepo?: ExceptionRepository | null,
    private rootCauseAgent?: RootCauseAgent | null,
    private actionPlannerAgent?: ActionPlannerAgent | null
  ) {}

  /**
   * Claims and processes up to maxJobs pending AI jobs asynchronously.
   */
  async processPendingJobs(
    workerId: string = `worker-${Math.random().toString(36).substring(2, 7)}`,
    maxJobs: number = 5
  ): Promise<WorkerProcessResult> {
    const result: WorkerProcessResult = {
      processedCount: 0,
      completedCount: 0,
      failedCount: 0,
      jobs: [],
    };

    let dbClient;
    try {
      dbClient = createAdminClient();
    } catch {
      // Fallback in-memory
    }

    const jobRepo = this.aiJobRepo || new AiJobRepository(dbClient);
    const incRepo = this.incidentRepo || (dbClient ? new IncidentRepository(dbClient) : null);
    const histRepo = this.historyRepo || (dbClient ? new IncidentHistoryRepository(dbClient) : null);
    const folRepo = this.followupRepo || (dbClient ? new FollowupRepository(dbClient) : null);
    const planRepo = this.plannerRepo || new PlannerRepository(dbClient);
    const excRepo = this.exceptionRepo || (dbClient ? new ExceptionRepository(dbClient) : null);

    const rcAgent = this.rootCauseAgent || new RootCauseAgent();
    const plannerAgent = this.actionPlannerAgent || new ActionPlannerAgent(planRepo);

    for (let i = 0; i < maxJobs; i++) {
      const job = await jobRepo.claimPendingJob(workerId);
      if (!job) break;

      result.processedCount++;
      const jobStart = Date.now();

      try {
        if (!incRepo) {
          throw new Error("IncidentRepository unavailable to process AI job");
        }

        // 1. Load Incident
        const incidentRow = await incRepo.getIncidentById(job.incident_id);
        if (!incidentRow) {
          throw new Error(`Incident not found for ID: ${job.incident_id}`);
        }

        // 2. Load History
        let historyRows: IncidentHistoryRow[] = [];
        if (histRepo) {
          const histMap = await histRepo.getHistoriesByIncidentIds([incidentRow.id]);
          historyRows = histMap.get(incidentRow.id) || [];
        }

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
          oldestOrderCode: latestHist?.sample_order_codes?.[0] || null,
          priorityScore: incidentRow.priority_score || 0,
          firstDetectedAt: incidentRow.first_detected_at,
          lastDetectedAt: incidentRow.last_detected_at,
          status: incidentRow.status,
        };

        // 3. Load Followup Case & Exceptions
        let followupCase: FollowupCaseRow | null = null;
        if (folRepo) {
          const cases = await folRepo.getCasesByIncidentKeys([incidentRow.incident_key]);
          followupCase = cases[0] || null;
        }

        let activeExceptions: any[] = [];
        if (excRepo) {
          try {
            const exceptionCodes = await excRepo.getActiveExceptionOrderCodes(new Date().toISOString());
            activeExceptions = Array.from(exceptionCodes).map((code) => ({
              order_code: code,
              reason_code: incidentRow.reason_code,
              expires_at: null,
            }));
          } catch {
            // Fallback
          }
        }

        // 4. Run Root Cause Agent (Cache-aware)
        const rcResponse = await rcAgent.analyzeIncident(incident, historyRows);

        // 5. Run Action Planner Agent (reads persisted Root Cause)
        await plannerAgent.analyzeIncident({
          incident: incidentRow,
          historyRows,
          rootCauseResult: rcResponse.analysis,
          followupCase,
          activeExceptions,
        });

        // 6. Mark Completed
        await jobRepo.markJobCompleted(job.id);
        result.completedCount++;
        result.jobs.push({
          jobId: job.id,
          incidentId: job.incident_id,
          status: "COMPLETED",
          durationMs: Date.now() - jobStart,
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
        await jobRepo.markJobFailed(job.id, rawMsg, delay, isPermanent);

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
