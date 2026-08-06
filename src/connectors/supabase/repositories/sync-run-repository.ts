import type { SupabaseClient } from "@supabase/supabase-js";
import type { SyncRunRow, SyncRunStatus } from "../types";

export class SyncRunRepository {
  private inMemoryRuns: SyncRunRow[] = [];

  constructor(private client?: SupabaseClient | null) {}

  clearMemory(): void {
    this.inMemoryRuns = [];
  }

  async createSyncRun(startedAt: string = new Date().toISOString()): Promise<SyncRunRow> {
    const newRun: Partial<SyncRunRow> = {
      started_at: startedAt,
      status: "running" as SyncRunStatus,
      fetched_order_count: 0,
      normalized_order_count: 0,
      incident_count: 0,
      created_at: startedAt,
    };

    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("sync_runs")
          .insert(newRun)
          .select()
          .single();

        if (!error && data) return data as SyncRunRow;
      } catch {
        // Fallback
      }
    }

    const fullRow: SyncRunRow = {
      id: `sync-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      started_at: startedAt,
      completed_at: null,
      status: "running",
      fetched_order_count: 0,
      normalized_order_count: 0,
      incident_count: 0,
      duration_ms: null,
      error_code: null,
      error_message: null,
      source_updated_at: null,
      created_at: startedAt,
    };
    this.inMemoryRuns.push(fullRow);
    return fullRow;
  }

  async updateSuccess(
    id: string,
    params: {
      completedAt: string;
      fetchedOrderCount: number;
      normalizedOrderCount: number;
      incidentCount: number;
      durationMs: number;
      sourceUpdatedAt?: string | null;
    }
  ): Promise<SyncRunRow> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("sync_runs")
          .update({
            completed_at: params.completedAt,
            status: "success" as SyncRunStatus,
            fetched_order_count: params.fetchedOrderCount,
            normalized_order_count: params.normalizedOrderCount,
            incident_count: params.incidentCount,
            duration_ms: params.durationMs,
            source_updated_at: params.sourceUpdatedAt || null,
          })
          .eq("id", id)
          .select()
          .single();

        if (!error && data) return data as SyncRunRow;
      } catch {
        // Fallback
      }
    }

    const item = this.inMemoryRuns.find((r) => r.id === id);
    if (item) {
      item.completed_at = params.completedAt;
      item.status = "success";
      item.fetched_order_count = params.fetchedOrderCount;
      item.normalized_order_count = params.normalizedOrderCount;
      item.incident_count = params.incidentCount;
      item.duration_ms = params.durationMs;
      item.source_updated_at = params.sourceUpdatedAt || null;
      return item;
    }

    const fallbackRow: SyncRunRow = {
      id,
      started_at: new Date().toISOString(),
      completed_at: params.completedAt,
      status: "success",
      fetched_order_count: params.fetchedOrderCount,
      normalized_order_count: params.normalizedOrderCount,
      incident_count: params.incidentCount,
      duration_ms: params.durationMs,
      error_code: null,
      error_message: null,
      source_updated_at: params.sourceUpdatedAt || null,
      created_at: params.completedAt,
    };
    this.inMemoryRuns.push(fallbackRow);
    return fallbackRow;
  }

  async updateFailed(
    id: string,
    params: {
      completedAt: string;
      durationMs: number;
      errorCode: string;
      errorMessage: string;
    }
  ): Promise<SyncRunRow> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("sync_runs")
          .update({
            completed_at: params.completedAt,
            status: "failed" as SyncRunStatus,
            duration_ms: params.durationMs,
            error_code: params.errorCode,
            error_message: params.errorMessage,
          })
          .eq("id", id)
          .select()
          .single();

        if (!error && data) return data as SyncRunRow;
      } catch {
        // Fallback
      }
    }

    const item = this.inMemoryRuns.find((r) => r.id === id);
    if (item) {
      item.completed_at = params.completedAt;
      item.status = "failed";
      item.duration_ms = params.durationMs;
      item.error_code = params.errorCode;
      item.error_message = params.errorMessage;
      return item;
    }

    const fallbackRow: SyncRunRow = {
      id,
      started_at: new Date().toISOString(),
      completed_at: params.completedAt,
      status: "failed",
      fetched_order_count: 0,
      normalized_order_count: 0,
      incident_count: 0,
      duration_ms: params.durationMs,
      error_code: params.errorCode,
      error_message: params.errorMessage,
      source_updated_at: null,
      created_at: params.completedAt,
    };
    this.inMemoryRuns.push(fallbackRow);
    return fallbackRow;
  }

  async getLatestSyncRun(): Promise<SyncRunRow | null> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("sync_runs")
          .select("*")
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!error && data) return data as SyncRunRow;
      } catch {
        // Fallback
      }
    }

    const sorted = [...this.inMemoryRuns].sort(
      (a, b) => new Date(b.started_at || 0).getTime() - new Date(a.started_at || 0).getTime()
    );
    return sorted[0] || null;
  }

  async getLatestSyncRuns(limit: number = 10): Promise<SyncRunRow[]> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("sync_runs")
          .select("*")
          .order("started_at", { ascending: false })
          .limit(limit);

        if (!error && data) return (data || []) as SyncRunRow[];
      } catch {
        // Fallback
      }
    }

    return [...this.inMemoryRuns]
      .sort((a, b) => new Date(b.started_at || 0).getTime() - new Date(a.started_at || 0).getTime())
      .slice(0, limit);
  }

  async getPreviousSuccessfulSyncRun(currentSyncRunId: string): Promise<SyncRunRow | null> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("sync_runs")
          .select("*")
          .eq("status", "success")
          .neq("id", currentSyncRunId)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!error && data) return (data as SyncRunRow) || null;
      } catch {
        // Fallback
      }
    }

    const matches = this.inMemoryRuns
      .filter((r) => r.status === "success" && r.id !== currentSyncRunId)
      .sort((a, b) => new Date(b.started_at || 0).getTime() - new Date(a.started_at || 0).getTime());
    return matches[0] || null;
  }
}
