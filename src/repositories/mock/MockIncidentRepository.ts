import type { IncidentRow, IncidentDbStatus } from "@/connectors/supabase/types";
import type { Incident } from "@/engine/incident";
import type { IIncidentRepository } from "../interfaces/IIncidentRepository";

export class MockIncidentRepository implements IIncidentRepository {
  private inMemoryIncidents: IncidentRow[] = [];

  clearMemory(): void {
    this.inMemoryIncidents = [];
  }

  seed(incidents: IncidentRow[]): void {
    this.inMemoryIncidents = [...incidents];
  }

  async upsertIncidents(
    incidents: Incident[],
    syncRunId: string
  ): Promise<IncidentRow[]> {
    const resultRows: IncidentRow[] = [];
    for (const inc of incidents) {
      const idx = this.inMemoryIncidents.findIndex((item) => item.incident_key === inc.incidentKey);
      
      const row: IncidentRow = {
        id: idx >= 0 ? this.inMemoryIncidents[idx].id : `inc-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        incident_key: inc.incidentKey,
        warehouse_id: inc.warehouseId,
        warehouse_name: inc.warehouseName,
        reason_code: inc.reasonCode,
        reason_name: inc.reasonName,
        status: "open" as IncidentDbStatus,
        priority_score: Math.round(inc.priorityScore),
        first_detected_at: inc.firstDetectedAt,
        last_detected_at: inc.lastDetectedAt,
        last_sync_run_id: syncRunId,
        resolved_at: null,
      };

      if (idx >= 0) {
        this.inMemoryIncidents[idx] = row;
      } else {
        this.inMemoryIncidents.push(row);
      }
      resultRows.push(row);
    }
    return resultRows;
  }

  async resolveAbsentIncidents(
    currentActiveKeys: string[],
    syncRunId: string,
    resolvedAt: string = new Date().toISOString()
  ): Promise<number> {
    let count = 0;
    for (const inc of this.inMemoryIncidents) {
      if ((inc.status === "open" || inc.status === "monitoring") && !currentActiveKeys.includes(inc.incident_key)) {
        inc.status = "resolved";
        inc.resolved_at = resolvedAt;
        count++;
      }
    }
    return count;
  }

  async getOpenIncidents(): Promise<IncidentRow[]> {
    return this.inMemoryIncidents
      .filter((i) => i.status === "open" || i.status === "monitoring")
      .sort((a, b) => b.priority_score - a.priority_score);
  }

  async getIncidentById(id: string): Promise<IncidentRow | null> {
    return this.inMemoryIncidents.find((i) => i.id === id || i.incident_key === id) || null;
  }

  async getIncidentsBySyncRunId(syncRunId: string): Promise<IncidentRow[]> {
    return this.inMemoryIncidents.filter((i) => i.last_sync_run_id === syncRunId);
  }
}
