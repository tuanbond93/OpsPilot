export interface IPlannerService {
  createPlan(incidentId: string): Promise<any>;
  getPlanById(planId: string): Promise<any>;
}