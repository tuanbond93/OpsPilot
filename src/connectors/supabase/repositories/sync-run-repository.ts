import type { SupabaseClient } from "@supabase/supabase-js";
import type { SyncRunRow, SyncRunStatus } from "../types";

export class SyncRunRepository {
  constructor(private client: SupabaseClient) {}

  async createSyncRun(startedAt: string = new Date().toISOString()): Promise<SyncRunRow> {
    const { data, error } = await this.client
      .from("sync_runs")
      .insert({
        started_at: startedAt,
        status: "running" as SyncRunStatus,
        fetched_order_count: 0,
        normalized_order_count: 0,
        incident_count: 0,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`SyncRunRepository.createSyncRun failed: ${error.message}`);
    }

    return data as SyncRunRow;
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

    if (error) {
      throw new Error(`SyncRunRepository.updateSuccess failed: ${error.message}`);
    }

    return data as SyncRunRow;
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

    if (error) {
      throw new Error(`SyncRunRepository.updateFailed failed: ${error.message}`);
    }

    return data as SyncRunRow;
  }

  async getLatestSyncRuns(limit: number = 10): Promise<SyncRunRow[]> {
    const { data, error } = await this.client
      .from("sync_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`SyncRunRepository.getLatestSyncRuns failed: ${error.message}`);
    }

    return (data || []) as SyncRunRow[];
  }

  async getPreviousSuccessfulSyncRun(currentSyncRunId: string): Promise<SyncRunRow | null> {
    const { data, error } = await this.client
      .from("sync_runs")
      .select("*")
      .eq("status", "success")
      .neq("id", currentSyncRunId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return null;
    }

    return (data as SyncRunRow) || null;
  }
}
