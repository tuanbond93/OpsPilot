import type { SupabaseClient } from "@supabase/supabase-js";
import type { IncidentHistoryRow } from "@/connectors/supabase/types";
import type { Incident } from "@/engine/incident";
import { isFallbackAllowed } from "@/connectors/supabase/fallback-policy";
import type { IIncidentHistoryRepository } from "../interfaces/IIncidentHistoryRepository";

export class SupabaseIncidentHistoryRepository implements IIncidentHistoryRepository {
  private inMemoryHistory: IncidentHistoryRow[] = [];

  constructor(private client?: SupabaseClient | null) {}

  clearMemory(): void {
    this.inMemoryHistory = [];
  }

  /**
   * Inserts history snapshot for each current incident
   * Prevents duplicates via unique constraint on (incident_id, sync_run_id)
   */
  async insertHistoryRecords(
    incidentMap: Map<string, string>, // Map of incidentKey -> dbIncidentId
    incidents: Incident[],
    syncRunId: string,
    recordedAt: string = new Date().toISOString()
  ): Promise<number> {
    if (incidents.length === 0) return 0;

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
        pickup_journey_coverage_percent: inc.pickupJourneyCoveragePercent ?? 0,
        pickup_delayed_order_count: inc.pickupDelayedOrderCount ?? 0,
        maximum_pickup_wait_hours: inc.maximumPickupWaitHours ?? null,
        pickup_delay_order_codes: inc.pickupDelayOrderCodes ?? [],
      });
    }

    if (rows.length === 0) return 0;

    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("incident_history")
          .upsert(rows, {
            onConflict: "incident_id,sync_run_id",
          })
          .select();

        if (!error && data) return data.length;
        if (!isFallbackAllowed()) throw error || new Error("Insert history records failed");
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    this.inMemoryHistory.push(...rows);
    return rows.length;
  }

  /**
   * Batch fetches histories for multiple incident IDs in one single query.
   * Prevents N+1 database queries inside loops.
   */
  async getHistoriesByIncidentIds(
    incidentIds: string[]
  ): Promise<Map<string, IncidentHistoryRow[]>> {
    const resultMap = new Map<string, IncidentHistoryRow[]>();
    for (const id of incidentIds) {
      resultMap.set(id, []);
    }

    if (incidentIds.length === 0) return resultMap;

    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("incident_history")
          .select("*")
          .in("incident_id", incidentIds)
          .order("incident_id", { ascending: true })
          .order("recorded_at", { ascending: false });

        if (!error && data) {
          for (const row of data as IncidentHistoryRow[]) {
            const list = resultMap.get(row.incident_id);
            if (list) {
              list.push(row);
            }
          }
          return resultMap;
        }
        if (!isFallbackAllowed()) throw error || new Error("Batch fetch history failed");
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    for (const row of this.inMemoryHistory) {
      if (incidentIds.includes(row.incident_id)) {
        const list = resultMap.get(row.incident_id);
        if (list) {
          list.push(row);
        }
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
