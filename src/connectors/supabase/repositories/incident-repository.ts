import type { SupabaseClient } from "@supabase/supabase-js";
import type { IncidentRow, IncidentDbStatus } from "../types";
import type { Incident } from "@/engine/incident";

export class IncidentRepository {
  constructor(private client: SupabaseClient) {}

  /**
   * Upserts active incidents using stable incident_key
   */
  async upsertIncidents(
    incidents: Incident[],
    syncRunId: string
  ): Promise<IncidentRow[]> {
    if (incidents.length === 0) return [];

    const rows = incidents.map((inc) => ({
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
    }));

    const { data, error } = await this.client
      .from("incidents")
      .upsert(rows, {
        onConflict: "incident_key",
      })
      .select();

    if (error) {
      throw new Error(`IncidentRepository.upsertIncidents failed: ${error.message}`);
    }

    return (data || []) as IncidentRow[];
  }

  /**
   * Marks incidents absent from current sync run as resolved
   */
  async resolveAbsentIncidents(
    currentActiveKeys: string[],
    syncRunId: string,
    resolvedAt: string = new Date().toISOString()
  ): Promise<number> {
    let query = this.client
      .from("incidents")
      .update({
        status: "resolved" as IncidentDbStatus,
        resolved_at: resolvedAt,
      })
      .in("status", ["open", "monitoring"]);

    if (currentActiveKeys.length > 0) {
      // In Supabase SQL filter: not in list of active keys
      query = query.not("incident_key", "in", `(${currentActiveKeys.map((k) => `"${k}"`).join(",")})`);
    }

    const { data, error } = await query.select();

    if (error) {
      throw new Error(`IncidentRepository.resolveAbsentIncidents failed: ${error.message}`);
    }

    return (data || []).length;
  }

  async getOpenIncidents(): Promise<IncidentRow[]> {
    const { data, error } = await this.client
      .from("incidents")
      .select("*")
      .in("status", ["open", "monitoring"])
      .order("priority_score", { ascending: false });

    if (error) {
      throw new Error(`IncidentRepository.getOpenIncidents failed: ${error.message}`);
    }

    return (data || []) as IncidentRow[];
  }

  async getIncidentById(id: string): Promise<IncidentRow | null> {
    const { data, error } = await this.client
      .from("incidents")
      .select("*")
      .or(`id.eq.${id},incident_key.eq.${id}`)
      .maybeSingle();

    if (error) {
      return null;
    }

    return (data as IncidentRow) || null;
  }
}
