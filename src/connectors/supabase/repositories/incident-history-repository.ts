import type { SupabaseClient } from "@supabase/supabase-js";
import type { IncidentHistoryRow } from "../types";
import type { Incident } from "@/engine/incident";

export class IncidentHistoryRepository {
  constructor(private client: SupabaseClient) {}

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
        average_age_hours: inc.averageAgeHours,
        maximum_age_hours: inc.maximumAgeHours,
        oldest_order_code: inc.oldestOrderCode,
        priority_score: Math.round(inc.priorityScore),
        sample_order_codes: inc.sampleOrderCodes.slice(0, 5),
      });
    }

    if (rows.length === 0) return 0;

    const { error } = await this.client
      .from("incident_history")
      .upsert(rows, {
        onConflict: "incident_id,sync_run_id",
        ignoreDuplicates: true,
      });

    if (error) {
      throw new Error(`IncidentHistoryRepository.insertHistoryRecords failed: ${error.message}`);
    }

    return rows.length;
  }

  async getIncidentHistory(incidentId: string): Promise<IncidentHistoryRow[]> {
    const { data, error } = await this.client
      .from("incident_history")
      .select("*")
      .eq("incident_id", incidentId)
      .order("recorded_at", { ascending: false });

    if (error) {
      throw new Error(`IncidentHistoryRepository.getIncidentHistory failed: ${error.message}`);
    }

    return (data || []) as IncidentHistoryRow[];
  }
}
