import type { IFollowupService } from "../interfaces/IFollowupService";

export class NoOpFollowupService implements IFollowupService {
  async getAllCases(): Promise<any> {
    throw new Error("Not implemented yet: FollowupService.getAllCases");
  }
  async getCaseById(id: string): Promise<any> {
    throw new Error("Not implemented yet: FollowupService.getCaseById");
  }
  async confirmFollowupAction(id: string, action: string, confirmedBy?: string): Promise<any> {
    throw new Error("Not implemented yet: FollowupService.confirmFollowupAction");
  }
  async handleFollowupStateConfirmation(action: any, confirmedBy: string): Promise<any> {
    throw new Error("Not implemented yet: FollowupService.handleFollowupStateConfirmation");
  }
  async processIncidentFollowups(): Promise<any> {
    throw new Error("Not implemented yet: FollowupService.processIncidentFollowups");
  }
}