import type { SupabaseClient } from "@supabase/supabase-js";
import type { IncidentRow, IncidentDbStatus } from "@/connectors/supabase/types";
import type { Incident } from "@/engine/incident";
import { BaseRepository } from "../base/BaseRepository";
import type { IIncidentRepository } from "../interfaces/IIncidentRepository";
import { logger } from "@/observability/logger";

export class SupabaseIncidentRepository extends BaseRepository implements IIncidentRepository {
  constructor(client: SupabaseClient) {
    super(client);
  }

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

    const query = this.client
      .from("incidents")
      .upsert(rows, {
        onConflict: "incident_key",
      })
      .select();

    return this.executeMany<IncidentRow>(query as any);
  }

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
      query = query.not("incident_key", "in", `(${currentActiveKeys.map((k) => `"${k}"`).join(",")})`);
    }

    const { data, error } = await query.select();
    if (error) {
      logger.error({
        component: "SupabaseIncidentRepository",
        operation: "resolveAbsentIncidents",
        status: "failed",
        message: `[SupabaseIncidentRepository] resolveAbsentIncidents query failed: ${error.message}`,
        error,
      });
      throw error;
    }
    return data ? data.length : 0;
  }

  async getOpenIncidents(): Promise<IncidentRow[]> {
    const query = this.client
      .from("incidents")
      .select("*")
      .in("status", ["open", "monitoring"])
      .order("priority_score", { ascending: false });

    return this.executeMany<IncidentRow>(query as any);
  }

  async getIncidentById(id: string): Promise<IncidentRow | null> {
    const query = this.client
      .from("incidents")
      .select("*")
      .or(`id.eq.${id},incident_key.eq.${id}`)
      .maybeSingle();

    return this.executeOptional<IncidentRow>(query as any);
  }

  async getIncidentsBySyncRunId(syncRunId: string): Promise<IncidentRow[]> {
    const query = this.client
      .from("incidents")
      .select("*")
      .eq("last_sync_run_id", syncRunId);

    return this.executeMany<IncidentRow>(query as any);
  }
}
