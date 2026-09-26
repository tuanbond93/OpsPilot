import type {
  CheckpointWorkUnit,
  CheckpointObservabilitySnapshot,
  CheckpointStage,
} from "@/domain/checkpoint-v2/types";
import type {
  ICheckpointWorkQueueRepository,
  CreateWorkUnitInput,
} from "../interfaces/ICheckpointWorkQueueRepository";

export class MockCheckpointWorkQueueRepository implements ICheckpointWorkQueueRepository {
  private units = new Map<string, CheckpointWorkUnit>();

  async createWorkUnits(inputs: CreateWorkUnitInput[]): Promise<number> {
    const now = new Date().toISOString();
    let created = 0;

    for (const input of inputs) {
      // Idempotency: if idempotencyKey already exists, do not recreate
      const existing = [...this.units.values()].find(
        (u) => u.idempotencyKey === input.idempotencyKey
      );
      if (existing) continue;

      const id = crypto.randomUUID();
      const unit: CheckpointWorkUnit = {
        id,
        checkpointAt: input.checkpointAt,
        syncRunId: input.syncRunId,
        stage: input.stage,
        workType: input.workType,
        partitionKey: input.partitionKey,
        cursor: input.cursor,
        status: "PENDING",
        executionMode: input.executionMode || "PRODUCTION",
        attempts: 0,
        maxAttempts: input.maxAttempts || 3,
        leaseOwner: null,
        leaseExpiresAt: null,
        idempotencyKey: input.idempotencyKey,
        startedAt: null,
        completedAt: null,
        failureCode: null,
        lastSafeError: null,
        retryAfter: null,
        createdAt: now,
        updatedAt: now,
      };
      this.units.set(id, unit);
      created++;
    }

    return created;
  }

  async claimWorkUnits(
    checkpointAt: string,
    workerId: string,
    leaseDurationMs: number,
    limit: number,
    executionMode: "PRODUCTION" | "SHADOW" = "PRODUCTION"
  ): Promise<CheckpointWorkUnit[]> {
    const nowMs = Date.now();
    const leaseExpiry = new Date(nowMs + leaseDurationMs).toISOString();

    const candidates = [...this.units.values()]
      .filter((u) => u.checkpointAt === checkpointAt)
      .filter((u) => (u.executionMode || "PRODUCTION") === executionMode)
      .filter((u) => {
        if (u.attempts >= u.maxAttempts) return false;
        if (u.status === "COMPLETED") return false;
        if (u.status === "PENDING") {
          return !u.retryAfter || new Date(u.retryAfter).getTime() <= nowMs;
        }
        if (u.status === "LEASED") {
          return Boolean(u.leaseExpiresAt && new Date(u.leaseExpiresAt).getTime() <= nowMs);
        }
        return false;
      })
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(0, limit);

    const claimed: CheckpointWorkUnit[] = [];
    for (const c of candidates) {
      c.status = "LEASED";
      c.leaseOwner = workerId;
      c.leaseExpiresAt = leaseExpiry;
      c.startedAt = c.startedAt || new Date().toISOString();
      c.attempts += 1;
      c.updatedAt = new Date().toISOString();
      claimed.push({ ...c });
    }

    return claimed;
  }

  async releaseWorkUnits(ids: string[], workerId: string): Promise<void> {
    const now = new Date().toISOString();
    for (const id of ids) {
      const unit = this.units.get(id);
      if (unit && unit.status === "LEASED" && unit.leaseOwner === workerId) {
        unit.status = "PENDING";
        unit.leaseOwner = null;
        unit.leaseExpiresAt = null;
        unit.updatedAt = now;
      }
    }
  }

  async completeWorkUnit(id: string, workerId: string): Promise<void> {
    const unit = this.units.get(id);
    if (!unit) throw new Error(`WORK_UNIT_NOT_FOUND: ${id}`);
    if (unit.leaseOwner && unit.leaseOwner !== workerId) {
      throw new Error(`LEASE_OWNERSHIP_MISMATCH: owned by ${unit.leaseOwner}, not ${workerId}`);
    }

    unit.status = "COMPLETED";
    unit.completedAt = new Date().toISOString();
    unit.leaseOwner = null;
    unit.leaseExpiresAt = null;
    unit.updatedAt = new Date().toISOString();
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
    const unit = this.units.get(id);
    if (!unit) throw new Error(`WORK_UNIT_NOT_FOUND: ${id}`);

    const now = Date.now();
    unit.failureCode = error.failureCode;
    unit.lastSafeError = error.message.slice(0, 500);
    unit.leaseOwner = null;
    unit.leaseExpiresAt = null;
    unit.updatedAt = new Date().toISOString();

    if (!error.retryable || unit.attempts >= unit.maxAttempts) {
      unit.status = "FAILED";
    } else {
      unit.status = "PENDING";
      const backoff = error.retryAfterMs || 5_000 * Math.pow(2, unit.attempts - 1);
      unit.retryAfter = new Date(now + backoff).toISOString();
    }
  }

  async renewLease(id: string, workerId: string, extensionMs: number): Promise<boolean> {
    const unit = this.units.get(id);
    if (!unit || unit.status !== "LEASED" || unit.leaseOwner !== workerId) return false;
    unit.leaseExpiresAt = new Date(Date.now() + extensionMs).toISOString();
    unit.updatedAt = new Date().toISOString();
    return true;
  }

  async getWorkUnitsForCheckpoint(checkpointAt: string): Promise<CheckpointWorkUnit[]> {
    return [...this.units.values()]
      .filter((u) => u.checkpointAt === checkpointAt)
      .map((u) => ({ ...u }));
  }

  async getObservabilitySnapshot(
    checkpointAt: string,
    syncRunId: string
  ): Promise<CheckpointObservabilitySnapshot> {
    const units = [...this.units.values()].filter((u) => u.checkpointAt === checkpointAt);
    const nowMs = Date.now();

    const pending = units.filter((u) => u.status === "PENDING").length;
    const leased = units.filter((u) => u.status === "LEASED").length;
    const completed = units.filter((u) => u.status === "COMPLETED").length;
    const failed = units.filter((u) => u.status === "FAILED").length;

    let stage: CheckpointStage = "CREATED";
    if (units.length > 0) {
      stage = units[units.length - 1].stage;
      if (completed === units.length) stage = "COMPLETE";
      else if (failed > 0 && pending === 0 && leased === 0) stage = "FAILED_TERMINAL";
    }

    const oldestCreated = units.length > 0
      ? Math.min(...units.map((u) => new Date(u.createdAt).getTime()))
      : nowMs;

    const uniqueWorkers = new Set(
      units
        .filter((u) => u.status === "LEASED" && u.leaseExpiresAt && new Date(u.leaseExpiresAt).getTime() > nowMs)
        .map((u) => u.leaseOwner!)
    );

    return {
      checkpointAt,
      syncRunId,
      stage,
      totalWorkUnits: units.length,
      pendingUnits: pending,
      leasedUnits: leased,
      completedUnits: completed,
      failedUnits: failed,
      queueAgeMs: Math.max(0, nowMs - oldestCreated),
      oldestWorkAgeMs: Math.max(0, nowMs - oldestCreated),
      activeWorkerCount: uniqueWorkers.size,
      isStalled: leased === 0 && pending > 0 && units.some((u) => u.attempts >= u.maxAttempts),
      estimatedRemainingTimeMs: (pending + leased) * 500,
    };
  }

  // Test helper: simulate time fast-forward to expire leases and retry backoffs
  expireAllLeases(): void {
    const expiredTime = new Date(Date.now() - 1000).toISOString();
    for (const unit of this.units.values()) {
      if (unit.status === "LEASED") {
        unit.leaseExpiresAt = expiredTime;
      }
      if (unit.retryAfter) {
        unit.retryAfter = expiredTime;
      }
    }
  }

  // Test helper: clear all units
  clear(): void {
    this.units.clear();
  }
}

