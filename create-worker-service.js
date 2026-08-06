const fs = require('fs');
const workerCode = fs.readFileSync('src/jobs/ai-analysis-worker.ts', 'utf8');

const serviceCode = `
import type { IAiWorkerService } from "../interfaces/IAiWorkerService";
import type { IAiJobRepository } from "../../repositories/interfaces/IAiJobRepository";
import type { IIncidentRepository } from "../../repositories/interfaces/IIncidentRepository";
import type { IFollowupRepository } from "../../repositories/interfaces/IFollowupRepository";
import type { IPlannerRepository } from "../../repositories/interfaces/IPlannerRepository";
import type { RootCauseAgent } from "../../agents/root-cause";
import type { ActionPlannerAgent } from "../../agents/action-planner";
import type { Incident, IncidentReasonCode } from "../../engine/incident";

// Inline interfaces to avoid importing from connectors/supabase
interface IIncidentHistoryRepository {
  getHistoriesByIncidentIds(incidentIds: string[]): Promise<Map<string, any[]>>;
}

interface IExceptionRepository {
  getActiveExceptionOrderCodes(cutoffDate: string): Promise<Set<string>>;
}

export class AiWorkerService implements IAiWorkerService {
  constructor(
    private aiJobRepo: IAiJobRepository,
    private incidentRepo: IIncidentRepository,
    private historyRepo: IIncidentHistoryRepository,
    private followupRepo: IFollowupRepository,
    private plannerRepo: IPlannerRepository,
    private exceptionRepo: IExceptionRepository,
    private rootCauseAgent: RootCauseAgent,
    private actionPlannerAgent: ActionPlannerAgent
  ) {}

  async enqueueJob(jobData: any): Promise<void> {
    throw new Error("Not implemented yet: AiWorkerService.enqueueJob");
  }

  async processPendingJobs(
    workerId: string = \`worker-\${Math.random().toString(36).substring(2, 7)}\`,
    maxJobs: number = 5
  ): Promise<any> {
    const result = {
      processedCount: 0,
      completedCount: 0,
      failedCount: 0,
      jobs: [] as any[],
    };

    for (let i = 0; i < maxJobs; i++) {
      const job = await this.aiJobRepo.claimPendingJob(workerId);
      if (!job) break;

      result.processedCount++;
      const jobStart = Date.now();

      try {
        // 1. Load Incident
        const incidentRow = await this.incidentRepo.getIncidentById(job.incident_id);
        if (!incidentRow) {
          throw new Error(\`Incident not found for ID: \${job.incident_id}\`);
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
          oldestOrderCode: latestHist?.sample_order_codes?.[0] || null,
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
        await this.actionPlannerAgent.analyzeIncident({
          incident: incidentRow,
          historyRows,
          rootCauseResult: rcResponse.analysis,
          followupCase,
          activeExceptions,
        });

        // 6. Mark Completed
        await this.aiJobRepo.markJobCompleted(job.id);
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
`;

fs.writeFileSync('src/services/impl/AiWorkerService.ts', serviceCode);
// Clean up NoOpAiWorkerService.ts
try {
  fs.unlinkSync('src/services/impl/NoOpAiWorkerService.ts');
} catch(e) {}
