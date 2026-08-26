import type { IPlannerService, GeneratePlanOptions } from "../interfaces/IPlannerService";
import { logger } from '@/observability/logger';
import type { IPlannerRepository } from "@/repositories/interfaces/IPlannerRepository";
import type { IIncidentRepository } from "@/repositories/interfaces/IIncidentRepository";
import type { IIncidentHistoryRepository } from "@/repositories/interfaces/IIncidentHistoryRepository";
import type { IFollowupRepository } from "@/repositories/interfaces/IFollowupRepository";
import type { IExceptionRepository } from "@/repositories/interfaces/IExceptionRepository";
import type { IAiJobRepository } from "@/repositories/interfaces/IAiJobRepository";
import type { IActionQueue } from "@/engine/action-queue/IActionQueue";
import { RootCauseAgent } from "@/agents/root-cause";
import { ActionPlannerAgent } from "@/agents/action-planner";

const MAX_REVIEWED_BY_LENGTH = 200;

export class PlannerService implements IPlannerService {
  constructor(
    private plannerRepo: IPlannerRepository,
    private incidentRepo: IIncidentRepository,
    private incidentHistoryRepo: IIncidentHistoryRepository,
    private followupRepo: IFollowupRepository,
    private exceptionRepo: IExceptionRepository,
    private aiJobRepo: IAiJobRepository,
    private actionQueue: IActionQueue,
    private rootCauseAgent: RootCauseAgent,
    private actionPlannerAgent: ActionPlannerAgent
  ) {}

  async generatePlan(
    incidentId: string,
    options?: GeneratePlanOptions
  ): Promise<{
    ok: boolean;
    cached?: boolean;
    runId?: string;
    result?: any;
    error?: string;
    message?: string;
  }> {
    try {
      const provider = options?.provider || undefined;
      const model = options?.model || undefined;
      const forceRegenerate = Boolean(options?.forceRegenerate);
      const requestedBy = options?.requestedBy ? String(options.requestedBy).trim() : undefined;

      if (forceRegenerate && (!requestedBy || requestedBy.length === 0)) {
        return {
          ok: false,
          error: "MissingRequestedBy",
          message: "requestedBy is mandatory when forceRegenerate is true.",
        };
      }

      const dbInc = await this.incidentRepo.getIncidentById(incidentId);
      if (!dbInc) {
        return {
          ok: false,
          error: "NotFound",
          message: `Incident '${incidentId}' not found.`,
        };
      }

      const historyRows = await this.incidentHistoryRepo.getIncidentHistory(dbInc.id);
      const followupCase = await this.followupRepo.getCaseById(dbInc.id);
      const followupEvents = followupCase ? await this.followupRepo.getEventsByCaseId(followupCase.id) : [];
      const activeExceptions = await this.exceptionRepo.getActiveExceptions();
      const actionHistory = await (this.actionQueue as any).getAllActions?.() || [];

      let rootCauseResult = null;
      try {
        const rcRes = await this.rootCauseAgent.analyzeIncident(
          {
            incidentId: dbInc.id,
            incidentKey: dbInc.incident_key,
            warehouseId: dbInc.warehouse_id,
            warehouseName: dbInc.warehouse_name || "Kho chưa xác định",
            reasonCode: dbInc.reason_code as any,
            reasonName: dbInc.reason_name,
            status: dbInc.status as any,
            priorityScore: dbInc.priority_score,
            firstDetectedAt: dbInc.first_detected_at,
            lastDetectedAt: dbInc.last_detected_at,
            affectedOrderCount: historyRows[0]?.affected_order_count || 0,
            sampleOrderCodes: historyRows[0]?.sample_order_codes || [],
            averageAgeHours: historyRows[0]?.average_age_hours || null,
            maximumAgeHours: historyRows[0]?.maximum_age_hours || null,
            oldestOrderCode: historyRows[0]?.oldest_order_code || null,
          },
          historyRows
        );
        rootCauseResult = rcRes.analysis;
      } catch {
        // Fallback
      }

      const res = await this.actionPlannerAgent.analyzeIncident({
        incident: dbInc,
        historyRows,
        rootCauseResult,
        followupCase,
        followupEvents,
        actionHistory,
        activeExceptions,
        options: { provider, model, forceRegenerate, requestedBy },
      });

      return {
        ok: true,
        cached: res.cached,
        runId: res.runId,
        result: res.result,
      };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        // Safe, non-fatal warning with structured error code
        logger.warn({ component: 'PlannerService', operation: 'generatePlan', status: 'warning', message: '[PlannerService] generatePlan failure', metadata: { code: 'PLANNER_GENERATION_FAILED', message } });
        return {
          ok: false,
          error: "PlannerGenerationFailed",
          message,
        };
      }
  }

  async getPlannerRunByIncidentId(
    incidentId: string
  ): Promise<{
    ok: boolean;
    aiStatus?: string;
    aiJob?: any;
    run?: any;
    reviewEvents?: any[];
    message?: string;
    error?: string;
  }> {
    try {
      const latestRun = await this.plannerRepo.getLatestPlannerRunByIncidentId(incidentId);
      const aiJob = await this.aiJobRepo.getLatestJobByIncidentId(incidentId);

      const aiStatus = aiJob ? aiJob.status : latestRun ? "COMPLETED" : "NONE";

      if (!latestRun) {
        return {
          ok: true,
          aiStatus: aiJob ? aiJob.status : "PENDING",
          aiJob,
          run: null,
          message: aiJob?.status === "PENDING" || aiJob?.status === "PROCESSING"
            ? "AI analysis is running..."
            : `No planner run found for incident '${incidentId}'.`,
        };
      }

      const reviewEvents = await this.plannerRepo.getReviewEventsByRunId(latestRun.id);

      return {
        ok: true,
        aiStatus,
        aiJob,
        run: latestRun,
        reviewEvents,
      };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ component: 'PlannerService', operation: 'getPlannerRunByIncidentId', status: 'warning', message: '[PlannerService] getPlannerRunByIncidentId failure', metadata: { code: 'PLANNER_RUN_LOOKUP_FAILED', message } });
        return {
          ok: false,
          error: "FetchPlannerRunFailed",
          message,
        };
      }
  }

  async reviewPlannerRun(
    id: string,
    decision: string,
    reviewedBy: string,
    note?: string | null
  ): Promise<{
    ok: boolean;
    run?: any;
    idempotent?: boolean;
    reviewedBy?: string;
    decision?: string;
    error?: string;
    message?: string;
  }> {
    try {
      const writeControlsEnabled =
        process.env.ENABLE_DASHBOARD_WRITE_CONTROLS === "true" ||
        process.env.NODE_ENV !== "production";

      if (!writeControlsEnabled) {
        return {
          ok: false,
          error: "WriteControlsDisabled",
          message: "Write controls are disabled in production environment.",
        };
      }

      const normalizedDecision = String(decision || "").trim().toUpperCase();
      if (normalizedDecision !== "APPROVED" && normalizedDecision !== "REJECTED") {
        return {
          ok: false,
          error: "InvalidDecision",
          message: "decision must be either 'APPROVED' or 'REJECTED'.",
        };
      }

      if (reviewedBy === undefined || reviewedBy === null) {
        return {
          ok: false,
          error: "MissingReviewedBy",
          message: "reviewedBy is required. Provide the identity of the operator reviewing this draft.",
        };
      }

      const trimmedReviewedBy = String(reviewedBy).trim();
      if (trimmedReviewedBy.length === 0) {
        return {
          ok: false,
          error: "EmptyReviewedBy",
          message: "reviewedBy must be a non-empty string after trimming whitespace.",
        };
      }

      if (trimmedReviewedBy.length > MAX_REVIEWED_BY_LENGTH) {
        return {
          ok: false,
          error: "ReviewedByTooLong",
          message: `reviewedBy must not exceed ${MAX_REVIEWED_BY_LENGTH} characters.`,
        };
      }

      const normalizedNote = note ? String(note).trim() : null;

      const run = await this.plannerRepo.getPlannerRunById(id);
      if (!run) {
        return {
          ok: false,
          error: "NotFound",
          message: `Planner run '${id}' not found.`,
        };
      }

      if (run.status === normalizedDecision) {
        return {
          ok: true,
          run,
          idempotent: true,
          message: `Planner run '${id}' is already in status '${normalizedDecision}'.`,
        };
      }

      const nowIso = new Date().toISOString();

      const updatedRun = await this.plannerRepo.updatePlannerRunStatus(
        id,
        normalizedDecision as any,
        trimmedReviewedBy,
        nowIso
      );

      await this.plannerRepo.insertReviewEvent({
        planner_run_id: id,
        event_type: normalizedDecision as any,
        actor: trimmedReviewedBy,
        note: normalizedNote,
        created_at: nowIso,
      });

      return {
        ok: true,
        run: updatedRun,
        idempotent: false,
        reviewedBy: trimmedReviewedBy,
        decision: normalizedDecision,
      };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ component: 'PlannerService', operation: 'reviewPlannerRun', status: 'warning', message: '[PlannerService] reviewPlannerRun failure', metadata: { code: 'PLANNER_REVIEW_FAILED', message } });
        return {
          ok: false,
          error: "ReviewPlannerRunFailed",
          message,
        };
      }
  }

  async listPlannerRuns(
    incidentId?: string,
    limit?: number
  ): Promise<{
    ok: boolean;
    runs?: any[];
    error?: string;
    message?: string;
  }> {
    try {
      const runs = await this.plannerRepo.getAllPlannerRuns(incidentId, limit);
      return {
        ok: true,
        runs,
      };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ component: 'PlannerService', operation: 'listPlannerRuns', status: 'warning', message: '[PlannerService] listPlannerRuns failure', metadata: { code: 'PLANNER_RUN_LIST_FAILED', message } });
        return {
          ok: false,
          error: "FetchPlannerRunsFailed",
          message,
        };
      }
  }

  async getPlannerRun(
    id: string
  ): Promise<{
    ok: boolean;
    run?: any;
    reviewEvents?: any[];
    error?: string;
    message?: string;
  }> {
    try {
      const run = await this.plannerRepo.getPlannerRunById(id);
      if (!run) {
        return {
          ok: false,
          error: "NotFound",
          message: `Planner run '${id}' not found.`,
        };
      }

      const reviewEvents = await this.plannerRepo.getReviewEventsByRunId(id);

      return {
        ok: true,
        run,
        reviewEvents,
      };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ component: 'PlannerService', operation: 'getPlannerRun', status: 'warning', message: '[PlannerService] getPlannerRun failure', metadata: { code: 'PLANNER_RUN_FETCH_FAILED', message } });
        return {
          ok: false,
          error: "FetchPlannerRunFailed",
          message,
        };
      }
  }
}
