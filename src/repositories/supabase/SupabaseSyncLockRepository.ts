import type { SupabaseClient } from "@supabase/supabase-js";
import type { ISyncLockRepository, SyncLockAcquireResult, SyncLockState } from "../interfaces/ISyncLockRepository";
import { logger } from "@/observability/logger";

export class SupabaseSyncLockRepository implements ISyncLockRepository {
  constructor(private client: SupabaseClient) {}

  async acquireLock(lockKey: string, ownerId: string, ttlMs: number): Promise<SyncLockAcquireResult> {
    const { data, error } = await this.client.rpc("acquire_sync_lock", {
      p_lock_key: lockKey,
      p_owner_id: ownerId,
      p_ttl_ms: ttlMs,
    });

    if (error) {
      logger.error({
        component: "SupabaseSyncLockRepository",
        operation: "acquireLock",
        status: "failed",
        message: `[SupabaseSyncLockRepository] acquireLock RPC error: ${error.message}`,
        errorCode: "SYNC_LOCK_FAILED",
        error,
      });
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      return { acquired: false, ownerId, lockKey };
    }

    return {
      acquired: Boolean(row.acquired),
      ownerId: row.owner_id || ownerId,
      lockKey: row.lock_key || lockKey,
      expiredTakeover: Boolean(row.expired_takeover),
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : undefined,
    };
  }

  async renewLock(lockKey: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const { data, error } = await this.client.rpc("renew_sync_lock", {
      p_lock_key: lockKey,
      p_owner_id: ownerId,
      p_ttl_ms: ttlMs,
    });

    if (error) {
      logger.error({
        component: "SupabaseSyncLockRepository",
        operation: "renewLock",
        status: "failed",
        message: `[SupabaseSyncLockRepository] renewLock RPC error: ${error.message}`,
        errorCode: "SYNC_LOCK_FAILED",
        error,
      });
      throw error;
    }

    return Boolean(data);
  }

  async releaseLock(lockKey: string, ownerId: string): Promise<boolean> {
    const { data, error } = await this.client.rpc("release_sync_lock", {
      p_lock_key: lockKey,
      p_owner_id: ownerId,
    });

    if (error) {
      logger.error({
        component: "SupabaseSyncLockRepository",
        operation: "releaseLock",
        status: "failed",
        message: `[SupabaseSyncLockRepository] releaseLock RPC error: ${error.message}`,
        errorCode: "SYNC_LOCK_FAILED",
        error,
      });
      throw error;
    }

    return Boolean(data);
  }

  async getLock(lockKey: string): Promise<SyncLockState | null> {
    const { data, error } = await this.client
      .from("sync_locks")
      .select("*")
      .eq("lock_key", lockKey)
      .maybeSingle();

    if (error) {
      logger.error({
        component: "SupabaseSyncLockRepository",
        operation: "getLock",
        status: "failed",
        message: `[SupabaseSyncLockRepository] getLock error: ${error.message}`,
        errorCode: "SYNC_LOCK_FAILED",
        error,
      });
      throw error;
    }

    if (!data) return null;

    return {
      lockKey: data.lock_key,
      ownerId: data.owner_id,
      acquiredAt: new Date(data.acquired_at).toISOString(),
      expiresAt: new Date(data.expires_at).toISOString(),
      heartbeatAt: new Date(data.heartbeat_at).toISOString(),
    };
  }
}
