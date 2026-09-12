import type { SupabaseClient } from "@supabase/supabase-js";
import type { SyncRunRow, SyncRunStatus, SyncPhase } from "@/connectors/supabase/types";
import { BaseRepository } from "../base/BaseRepository";
import type { ISyncRunRepository } from "../interfaces/ISyncRunRepository";

export class SupabaseSyncRunRepository extends BaseRepository implements ISyncRunRepository {
  constructor(client: SupabaseClient) {
    super(client);
  }

  async createSyncRun(startedAt: string = new Date().toISOString(), options: { id?: string; checkpointAt?: string } = {}): Promise<SyncRunRow> {
    const newRun: Partial<SyncRunRow> = {
      ...(options.id ? { id: options.id } : {}),
      started_at: startedAt,
      status: "running" as SyncRunStatus,
      current_phase: "CREATED",
      completed_phases: ["CREATED"],
      fetched_order_count: 0,
      normalized_order_count: 0,
      incident_count: 0,
      created_at: startedAt,
      checkpoint_at: options.checkpointAt || null,
    };

    const query = this.client
      .from("sync_runs")
      .insert(newRun)
      .select()
      .single();

    try {
      return await this.executeSingle<SyncRunRow>(query as any);
    } catch (error: any) {
      // A retry after an ambiguous network timeout may find the client-supplied
      // primary key already committed. Re-read that exact row; never create a
      // second sync run.
      if (options.id && error?.code === "23505") {
        const existing = this.client.from("sync_runs").select("*").eq("id", options.id).maybeSingle();
        return this.executeSingle<SyncRunRow>(existing as any);
      }
      throw error;
    }
  }

  async updatePhase(
    id: string,
    currentPhase: SyncPhase,
    completedPhases: SyncPhase[]
  ): Promise<SyncRunRow> {
    const query = this.client
      .from("sync_runs")
      .update({
        current_phase: currentPhase,
        completed_phases: completedPhases,
      })
      .eq("id", id)
      .select()
      .single();

    return this.executeSingle<SyncRunRow>(query as any);
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
    const query = this.client
      .from("sync_runs")
      .update({
        completed_at: params.completedAt,
        status: "success" as SyncRunStatus,
        current_phase: "COMPLETED",
        fetched_order_count: params.fetchedOrderCount,
        normalized_order_count: params.normalizedOrderCount,
        incident_count: params.incidentCount,
        duration_ms: params.durationMs,
        source_updated_at: params.sourceUpdatedAt || null,
      })
      .eq("id", id)
      .select()
      .single();

    return this.executeSingle<SyncRunRow>(query as any);
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
    const query = this.client
      .from("sync_runs")
      .update({
        completed_at: params.completedAt,
        status: "failed" as SyncRunStatus,
        current_phase: "FAILED",
        duration_ms: params.durationMs,
        error_code: params.errorCode,
        error_message: params.errorMessage,
      })
      .eq("id", id)
      .select()
      .single();

    return this.executeSingle<SyncRunRow>(query as any);
  }

  async getUnfinishedSyncRun(): Promise<SyncRunRow | null> {
    const query = this.client
      .from("sync_runs")
      .select("*")
      .or("status.eq.running,status.eq.failed")
      .neq("current_phase", "COMPLETED")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return this.executeOptional<SyncRunRow>(query as any);
  }

  async getLatestSyncRun(): Promise<SyncRunRow | null> {
    const query = this.client
      .from("sync_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return this.executeOptional<SyncRunRow>(query as any);
  }

  async getLatestSyncRuns(limit: number = 10): Promise<SyncRunRow[]> {
    const query = this.client
      .from("sync_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(limit);

    return this.executeMany<SyncRunRow>(query as any);
  }

  async getPreviousSuccessfulSyncRun(currentSyncRunId: string): Promise<SyncRunRow | null> {
    const query = this.client
      .from("sync_runs")
      .select("*")
      .eq("status", "success")
      .neq("id", currentSyncRunId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return this.executeOptional<SyncRunRow>(query as any);
  }

  async getSyncRunForCheckpoint(checkpointAt: string): Promise<SyncRunRow | null> {
    const query = this.client.from("sync_runs").select("*").eq("checkpoint_at", checkpointAt).maybeSingle();
    return this.executeOptional<SyncRunRow>(query as any);
  }
}
