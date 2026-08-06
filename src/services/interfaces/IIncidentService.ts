export interface IIncidentService {
  listIncidents(): Promise<{
    source: string;
    totalIncidents: number;
    incidents: any[];
  }>;

  getIncidentHistory(incidentId: string): Promise<{
    incident: any;
    history: any[];
    note?: string;
    message?: string;
  }>;

  analyzeRootCause(incidentId: string): Promise<{
    ok: boolean;
    data?: any;
    error?: string;
    message?: string;
  }>;

  getOpenIncidents(): Promise<any[]>;

  resolveIncident(incidentId: string): Promise<void>;
}