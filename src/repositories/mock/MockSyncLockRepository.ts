import type { ISyncLockRepository, SyncLockAcquireResult, SyncLockState } from "../interfaces/ISyncLockRepository";

export class MockSyncLockRepository implements ISyncLockRepository {
  private locks = new Map<string, SyncLockState>();

  async acquireLock(lockKey: string, ownerId: string, ttlMs: number): Promise<SyncLockAcquireResult> {
    const now = new Date();
    const existing = this.locks.get(lockKey);

    if (!existing) {
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      const state: SyncLockState = {
        lockKey,
        ownerId,
        acquiredAt: now.toISOString(),
        expiresAt,
        heartbeatAt: now.toISOString(),
      };
      this.locks.set(lockKey, state);
      return { acquired: true, ownerId, lockKey, expiredTakeover: false, expiresAt };
    }

    const existingExpiry = new Date(existing.expiresAt).getTime();
    if (existingExpiry < now.getTime()) {
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      const state: SyncLockState = {
        lockKey,
        ownerId,
        acquiredAt: now.toISOString(),
        expiresAt,
        heartbeatAt: now.toISOString(),
      };
      this.locks.set(lockKey, state);
      return { acquired: true, ownerId, lockKey, expiredTakeover: true, expiresAt };
    }

    return {
      acquired: false,
      ownerId: existing.ownerId,
      lockKey,
      expiresAt: existing.expiresAt,
    };
  }

  async renewLock(lockKey: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const now = new Date();
    const existing = this.locks.get(lockKey);

    if (!existing || existing.ownerId !== ownerId) {
      return false;
    }

    const existingExpiry = new Date(existing.expiresAt).getTime();
    if (existingExpiry < now.getTime()) {
      return false;
    }

    existing.expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    existing.heartbeatAt = now.toISOString();
    return true;
  }

  async releaseLock(lockKey: string, ownerId: string): Promise<boolean> {
    const existing = this.locks.get(lockKey);
    if (!existing || existing.ownerId !== ownerId) {
      return false;
    }
    this.locks.delete(lockKey);
    return true;
  }

  async getLock(lockKey: string): Promise<SyncLockState | null> {
    const existing = this.locks.get(lockKey);
    if (!existing) return null;
    return { ...existing };
  }

  clear(): void {
    this.locks.clear();
  }
}
