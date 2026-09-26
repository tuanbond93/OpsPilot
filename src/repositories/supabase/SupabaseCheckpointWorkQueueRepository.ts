import type { SupabaseClient } from "@supabase/supabase-js";
import { BaseRepository } from "../base/BaseRepository";
import type {
  ICheckpointWorkQueueRepository,
  CreateWorkUnitInput,
} from "../interfaces/ICheckpointWorkQueueRepository";
import type {
  CheckpointWorkUnit,
  CheckpointObservabilitySnapshot,
  WorkUnitStatus,
  CheckpointStage,
  WorkUnitType,
} from "@/domain/checkpoint-v2/types";

export class SupabaseCheckpointWorkQueueRepository
  extends BaseRepository
  implements ICheckpointWorkQueueRepository
{
  constructor(client: SupabaseClient) {
    super(client);
  }

  async createWorkUnits(units: CreateWorkUnitInput[]): Promise<number> {
    if (units.length === 0) return 0;

    const rows = units.map((u) => ({
      checkpoint_at: u.checkpointAt,
      sync_run_id: u.syncRunId,
      stage: u.stage,
      work_type: u.workType,
      partition_key: u.partitionKey,
      cursor: u.cursor,
      idempotency_key: u.idempotencyKey,
      max_attempts: u.maxAttempts ?? 3,
      execution_mode: u.executionMode || "PRODUCTION",
      status: "PENDING",
      attempts: 0,
    }));

    const query = this.client
      .from("checkpoint_work_units")
      .upsert(rows, { onConflict: "idempotency_key", ignoreDuplicates: true })
      .select("id");

    const result = await this.executeMany<{ id: string }>(query as any);
    return result.length;
  }

  async claimWorkUnits(
    checkpointAt: string,
    workerId: string,
    leaseDurationMs: number,
    limit: number,
    executionMode: "PRODUCTION" | "SHADOW" = "PRODUCTION"
  ): Promise<CheckpointWorkUnit[]> {
    const leaseSeconds = Math.max(1, Math.ceil(leaseDurationMs / 1000));
    const { data, error } = await this.client.rpc("claim_checkpoint_work_units", {
      p_checkpoint_at: checkpointAt,
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
      p_limit: limit,
      p_execution_mode: executionMode,
    });

    if (error) {
      throw new Error(`claim_checkpoint_work_units RPC failed: ${error.message} (${error.code})`);
    }

    if (!data || !Array.isArray(data)) {
      return [];
    }

    return data.map(this.mapRowToWorkUnit);
  }

  async releaseWorkUnits(ids: string[], workerId: string): Promise<void> {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const { error } = await this.client
      .from("checkpoint_work_units")
      .update({
        status: "PENDING",
        lease_owner: null,
        lease_expires_at: null,
        updated_at: now,
      })
      .in("id", ids)
      .eq("lease_owner", workerId)
      .eq("status", "LEASED");

    if (error) throw error;
  }

  async completeWorkUnit(id: string, workerId: string): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.client
      .from("checkpoint_work_units")
      .update({
        status: "COMPLETED",
        completed_at: now,
        lease_expires_at: null,
        updated_at: now,
      })
      .eq("id", id)
      .eq("lease_owner", workerId);

    if (error) throw error;
  }

  async failWorkUnit(
    id: string,
    workerId: string,
    error: {
      failureCode: string;
      message: string;
      retryable: boolean;
      retryAfterMs?: number;
    }
  ): Promise<void> {
    const now = new Date();
    const retryAfter = error.retryAfterMs
      ? new Date(now.getTime() + error.retryAfterMs).toISOString()
      : null;

    const { error: updateErr } = await this.client
      .from("checkpoint_work_units")
      .update({
        status: error.retryable ? "PENDING" : "FAILED",
        failure_code: error.failureCode,
        last_safe_error: error.message,
        retry_after: retryAfter,
        lease_owner: null,
        lease_expires_at: null,
        updated_at: now.toISOString(),
      })
      .eq("id", id);

    if (updateErr) throw updateErr;
  }

  async renewLease(id: string, workerId: string, extensionMs: number): Promise<boolean> {
    const newExpiry = new Date(Date.now() + extensionMs).toISOString();
    const now = new Date().toISOString();

    const { data, error } = await this.client
      .from("checkpoint_work_units")
      .update({
        lease_expires_at: newExpiry,
        updated_at: now,
      })
      .eq("id", id)
      .eq("lease_owner", workerId)
      .select("id");

    if (error || !data || data.length === 0) {
      return false;
    }
    return true;
  }

  async getWorkUnitsForCheckpoint(checkpointAt: string): Promise<CheckpointWorkUnit[]> {
    const query = this.client
      .from("checkpoint_work_units")
      .select("*")
      .eq("checkpoint_at", checkpointAt)
      .order("created_at", { ascending: true });

    const rows = await this.executeMany<any>(query as any);
    return rows.map(this.mapRowToWorkUnit);
  }

  async getObservabilitySnapshot(
    checkpointAt: string,
    syncRunId: string
  ): Promise<CheckpointObservabilitySnapshot> {
    const units = await this.getWorkUnitsForCheckpoint(checkpointAt);

    let pendingCount = 0;
    let leasedCount = 0;
    let completedCount = 0;
    let failedCount = 0;
    const activeLeaseOwners = new Set<string>();

    for (const u of units) {
      if (u.status === "PENDING") pendingCount++;
      else if (u.status === "LEASED") {
        leasedCount++;
        if (u.leaseOwner) activeLeaseOwners.add(u.leaseOwner);
      } else if (u.status === "COMPLETED") completedCount++;
      else if (u.status === "FAILED") failedCount++;
    }

    return {
      checkpointAt,
      syncRunId,
      stage: units[0]?.stage || "INGESTING",
      totalWorkUnits: units.length,
      pendingUnits: pendingCount,
      leasedUnits: leasedCount,
      completedUnits: completedCount,
      failedUnits: failedCount,
      queueAgeMs: 0,
      oldestWorkAgeMs: 0,
      activeWorkerCount: activeLeaseOwners.size,
      isStalled: false,
      estimatedRemainingTimeMs: 0,
    };
  }

  private mapRowToWorkUnit(row: any): CheckpointWorkUnit {
    return {
      id: row.id,
      checkpointAt: row.checkpoint_at,
      syncRunId: row.sync_run_id,
      stage: row.stage as CheckpointStage,
      workType: row.work_type as WorkUnitType,
      partitionKey: row.partition_key,
      cursor: row.cursor || {},
      status: row.status as WorkUnitStatus,
      executionMode: row.execution_mode || "PRODUCTION",
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
      idempotencyKey: row.idempotency_key,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      failureCode: row.failure_code,
      lastSafeError: row.last_safe_error,
      retryAfter: row.retry_after,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
