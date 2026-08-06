import { IPlannerService } from '../interfaces/IPlannerService';
export class NoOpPlannerService implements IPlannerService {
  async createPlan(incidentId: string): Promise<any> { throw new Error('Not implemented yet: PlannerService.createPlan'); }
  async getPlanById(planId: string): Promise<any> { throw new Error('Not implemented yet: PlannerService.getPlanById'); }
}