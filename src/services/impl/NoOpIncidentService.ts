import { IIncidentService } from '../interfaces/IIncidentService';
export class NoOpIncidentService implements IIncidentService {
  async getOpenIncidents(): Promise<any[]> { throw new Error('Not implemented yet: IncidentService.getOpenIncidents'); }
  async resolveIncident(incidentId: string): Promise<void> { throw new Error('Not implemented yet: IncidentService.resolveIncident'); }
}