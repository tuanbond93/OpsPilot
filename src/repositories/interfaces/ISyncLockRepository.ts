export interface SyncLockAcquireResult {
  acquired: boolean;
  ownerId: string;
  lockKey: string;
  expiredTakeover?: boolean;
  expiresAt?: string;
  error?: string;
}

export interface SyncLockState {
  lockKey: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
}

export interface ISyncLockRepository {
  acquireLock(lockKey: string, ownerId: string, ttlMs: number): Promise<SyncLockAcquireResult>;
  renewLock(lockKey: string, ownerId: string, ttlMs: number): Promise<boolean>;
  releaseLock(lockKey: string, ownerId: string): Promise<boolean>;
  getLock(lockKey: string): Promise<SyncLockState | null>;
}
