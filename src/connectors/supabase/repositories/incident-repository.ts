import type { SupabaseClient } from "@supabase/supabase-js";
import type { IncidentRow } from "../types";
import type { Incident } from "@/engine/incident";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";

export class IncidentRepository {
  constructor(private client?: SupabaseClient | null) {
    // Retaining signature for compatibility. The actual database client resolution
    // has been moved to the RepositoryFactory IoC wrapper.
  }

  clearMemory(): void {
    const repo = RepositoryFactory.getIncidentRepository();
    if (repo && typeof (repo as any).clearMemory === "function") {
      (repo as any).clearMemory();
    }
  }

  async upsertIncidents(
    incidents: Incident[],
    syncRunId: string
  ): Promise<IncidentRow[]> {
    return RepositoryFactory.getIncidentRepository().upsertIncidents(incidents, syncRunId);
  }

  async resolveAbsentIncidents(
    currentActiveKeys: string[],
    syncRunId: string,
    resolvedAt?: string
  ): Promise<number> {
    return RepositoryFactory.getIncidentRepository().resolveAbsentIncidents(
      currentActiveKeys,
      syncRunId,
      resolvedAt
    );
  }

  async getOpenIncidents(): Promise<IncidentRow[]> {
    return RepositoryFactory.getIncidentRepository().getOpenIncidents();
  }

  async getIncidentById(id: string): Promise<IncidentRow | null> {
    return RepositoryFactory.getIncidentRepository().getIncidentById(id);
  }
}
