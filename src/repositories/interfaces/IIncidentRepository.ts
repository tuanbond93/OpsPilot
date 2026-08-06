import type { IncidentRow } from "@/connectors/supabase/types";
import type { Incident } from "@/engine/incident";

export interface IIncidentRepository {
  upsertIncidents(incidents: Incident[], syncRunId: string): Promise<IncidentRow[]>;
  resolveAbsentIncidents(currentActiveKeys: string[], syncRunId: string, resolvedAt?: string): Promise<number>;
  getOpenIncidents(): Promise<IncidentRow[]>;
  getIncidentById(id: string): Promise<IncidentRow | null>;
  getIncidentsBySyncRunId(syncRunId: string): Promise<IncidentRow[]>;
}
