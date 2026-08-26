import type { IIncidentHistoryRepository } from "../interfaces/IIncidentHistoryRepository";
import type { IncidentHistoryRow } from "@/connectors/supabase/types";
import type { Incident } from "@/engine/incident";

export class MockIncidentHistoryRepository implements IIncidentHistoryRepository {
  private inMemoryHistory: IncidentHistoryRow[] = [];

  clearMemory(): void {
    this.inMemoryHistory = [];
  }

  async insertHistoryRecords(
    incidentMap: Map<string, string>,
    incidents: Incident[],
    syncRunId: string,
    recordedAt: string = new Date().toISOString()
  ): Promise<number> {
    const rows: IncidentHistoryRow[] = [];
    for (const inc of incidents) {
      const dbId = incidentMap.get(inc.incidentKey);
      if (!dbId) continue;
      rows.push({
        incident_id: dbId,
        sync_run_id: syncRunId,
        recorded_at: recordedAt,
        affected_order_count: inc.affectedOrderCount,
        average_age_hours: inc.averageAgeHours ? Math.round(inc.averageAgeHours * 10) / 10 : undefined,
        maximum_age_hours: inc.maximumAgeHours ? Math.round(inc.maximumAgeHours * 10) / 10 : undefined,
        oldest_order_code: inc.oldestOrderCode || null,
        priority_score: Math.round(inc.priorityScore),
        sample_order_codes: inc.sampleOrderCodes ? inc.sampleOrderCodes.slice(0, 5) : [],
      });
    }
    this.inMemoryHistory.push(...rows);
    return rows.length;
  }

  async getHistoriesByIncidentIds(incidentIds: string[]): Promise<Map<string, IncidentHistoryRow[]>> {
    const resultMap = new Map<string, IncidentHistoryRow[]>();
    for (const id of incidentIds) {
      resultMap.set(id, []);
    }
    for (const row of this.inMemoryHistory) {
      if (incidentIds.includes(row.incident_id)) {
        resultMap.get(row.incident_id)?.push(row);
      }
    }
    return resultMap;
  }

  async getHistoryByIncidentId(incidentId: string): Promise<IncidentHistoryRow[]> {
    const map = await this.getHistoriesByIncidentIds([incidentId]);
    return map.get(incidentId) || [];
  }

  async getIncidentHistory(incidentId: string): Promise<IncidentHistoryRow[]> {
    return this.getHistoryByIncidentId(incidentId);
  }
}
