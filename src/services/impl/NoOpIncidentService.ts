import type { IIncidentService } from "../interfaces/IIncidentService";

export class NoOpIncidentService implements IIncidentService {
  async listIncidents(): Promise<any> {
    throw new Error("Not implemented yet: IncidentService.listIncidents");
  }
  async getIncidentHistory(incidentId: string): Promise<any> {
    throw new Error("Not implemented yet: IncidentService.getIncidentHistory");
  }
  async analyzeRootCause(incidentId: string): Promise<any> {
    throw new Error("Not implemented yet: IncidentService.analyzeRootCause");
  }
  async getOpenIncidents(): Promise<any[]> {
    throw new Error("Not implemented yet: IncidentService.getOpenIncidents");
  }
  async resolveIncident(incidentId: string): Promise<void> {
    throw new Error("Not implemented yet: IncidentService.resolveIncident");
  }
}