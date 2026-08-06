import type { SupabaseClient } from "@supabase/supabase-js";
import type { IncidentRow, IncidentDbStatus } from "../types";
import type { Incident } from "@/engine/incident";
import { isFallbackAllowed } from "../fallback-policy";

export class IncidentRepository {
  private inMemoryIncidents: IncidentRow[] = [];

  constructor(private client?: SupabaseClient | null) {}

  clearMemory(): void {
    this.inMemoryIncidents = [];
  }

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

    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("incidents")
          .upsert(rows, {
            onConflict: "incident_key",
          })
          .select();

        if (!error && data) {
          return data as IncidentRow[];
        }
        if (!isFallbackAllowed()) {
          throw error || new Error("IncidentRepository.upsertIncidents DB call failed");
        }
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    // In-memory fallback
    const resultRows: IncidentRow[] = [];
    for (const r of rows) {
      const idx = this.inMemoryIncidents.findIndex((item) => item.incident_key === r.incident_key);
      const fullRow: IncidentRow = {
        id: idx >= 0 ? this.inMemoryIncidents[idx].id : `inc-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        ...r,
      };
      if (idx >= 0) {
        this.inMemoryIncidents[idx] = fullRow;
      } else {
        this.inMemoryIncidents.push(fullRow);
      }
      resultRows.push(fullRow);
    }
    return resultRows;
  }

  /**
   * Marks incidents absent from current sync run as resolved
   */
  async resolveAbsentIncidents(
    currentActiveKeys: string[],
    syncRunId: string,
    resolvedAt: string = new Date().toISOString()
  ): Promise<number> {
    if (this.client) {
      try {
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
        if (!error && data) {
          return data.length;
        }
        if (!isFallbackAllowed()) {
          throw error || new Error("IncidentRepository.resolveAbsentIncidents DB call failed");
        }
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

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
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("incidents")
          .select("*")
          .in("status", ["open", "monitoring"])
          .order("priority_score", { ascending: false });

        if (!error && data) {
          return data as IncidentRow[];
        }
        if (!isFallbackAllowed()) {
          throw error || new Error("IncidentRepository.getOpenIncidents DB query failed");
        }
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    return this.inMemoryIncidents
      .filter((i) => i.status === "open" || i.status === "monitoring")
      .sort((a, b) => b.priority_score - a.priority_score);
  }

  async getIncidentById(id: string): Promise<IncidentRow | null> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("incidents")
          .select("*")
          .or(`id.eq.${id},incident_key.eq.${id}`)
          .maybeSingle();

        if (!error && data) {
          return data as IncidentRow;
        }
        if (!isFallbackAllowed() && error) {
          throw error;
        }
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    return this.inMemoryIncidents.find((i) => i.id === id || i.incident_key === id) || null;
  }
}
