import type { IncidentHistoryRow } from "@/connectors/supabase/types";
import type { Incident } from "@/engine/incident";

export type { IncidentHistoryRow };

export interface IIncidentHistoryRepository {
  clearMemory?(): void;
  insertHistoryRecords(
    incidentMap: Map<string, string>,
    incidents: Incident[],
    syncRunId: string,
    recordedAt?: string
  ): Promise<number>;
  getHistoriesByIncidentIds(incidentIds: string[]): Promise<Map<string, IncidentHistoryRow[]>>;
  getHistoryByIncidentId(incidentId: string): Promise<IncidentHistoryRow[]>;
  getIncidentHistory(incidentId: string): Promise<IncidentHistoryRow[]>;
}
