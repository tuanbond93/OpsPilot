import type { PlannerRunRow, PlannerReviewEventRow, PlannerRunStatus } from "@/connectors/supabase/types";

export interface IPlannerRepository {
  createPlannerRun(run: Partial<PlannerRunRow>): Promise<PlannerRunRow>;
  getPlannerRunById(id: string): Promise<PlannerRunRow | null>;
  getPlannerRunByContextHashAndVersion(
    incidentId: string,
    contextHash: string,
    promptVersion: number,
    status?: PlannerRunStatus
  ): Promise<PlannerRunRow | null>;
  updatePlannerRunStatus(
    id: string,
    status: PlannerRunStatus,
    reviewedBy?: string,
    reviewedAt?: string
  ): Promise<PlannerRunRow | null>;
  updatePlannerRunResult(id: string, result: Record<string, unknown>): Promise<PlannerRunRow | null>;
  getAllPlannerRuns(incidentId?: string, limit?: number): Promise<PlannerRunRow[]>;
  getLatestPlannerRunByIncidentId(incidentId: string): Promise<PlannerRunRow | null>;
  insertReviewEvent(event: Partial<PlannerReviewEventRow>): Promise<PlannerReviewEventRow>;
  getReviewEventsByRunId(plannerRunId: string): Promise<PlannerReviewEventRow[]>;
  getRecentReviewEvents(limit?: number): Promise<PlannerReviewEventRow[]>;
}
