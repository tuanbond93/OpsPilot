import type { PlannerRunRow, PlannerReviewEventRow } from "@/connectors/supabase/types";

export interface IPlannerRepository {
  getLatestRunByIncidentId(incidentId: string): Promise<PlannerRunRow | null>;
  createRun(run: Partial<PlannerRunRow>): Promise<PlannerRunRow>;
  updateRunStatus(id: string, status: string, extra?: any): Promise<PlannerRunRow>;
  appendReviewEvent(event: Omit<PlannerReviewEventRow, "id" | "created_at">): Promise<PlannerReviewEventRow>;
  getRecentReviewEvents(limit?: number): Promise<PlannerReviewEventRow[]>;
}
