import type { IPlannerService, GeneratePlanOptions } from "../interfaces/IPlannerService";

export class NoOpPlannerService implements IPlannerService {
  async generatePlan(incidentId: string, options?: GeneratePlanOptions): Promise<any> {
    throw new Error("Not implemented yet: PlannerService.generatePlan");
  }
  async getPlannerRunByIncidentId(incidentId: string): Promise<any> {
    throw new Error("Not implemented yet: PlannerService.getPlannerRunByIncidentId");
  }
  async reviewPlannerRun(id: string, decision: string, reviewedBy: string, note?: string | null): Promise<any> {
    throw new Error("Not implemented yet: PlannerService.reviewPlannerRun");
  }
  async listPlannerRuns(incidentId?: string, limit?: number): Promise<any> {
    throw new Error("Not implemented yet: PlannerService.listPlannerRuns");
  }
  async getPlannerRun(id: string): Promise<any> {
    throw new Error("Not implemented yet: PlannerService.getPlannerRun");
  }
}