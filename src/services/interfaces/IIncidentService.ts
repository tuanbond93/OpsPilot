export interface IIncidentService {
  getOpenIncidents(): Promise<any[]>;
  resolveIncident(incidentId: string): Promise<void>;
}