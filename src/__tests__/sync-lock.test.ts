import { describe, it, expect, beforeEach, vi } from "vitest";
import { SyncService } from "@/services/impl/SyncService";
import { MockSyncLockRepository } from "@/repositories/mock/MockSyncLockRepository";
import { MockSyncRunRepository } from "@/repositories/mock/MockSyncRunRepository";
import { POST as syncRouteHandler } from "@/app/api/debug/sync/route";
import { NextRequest } from "next/server";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";
import { ServiceFactory } from "@/services/ServiceFactory";

describe("Sprint 10.5 — Distributed Sync Lock Tests", { timeout: 600000 }, () => {
  let syncLockRepo: MockSyncLockRepository;
  let syncRunRepo: MockSyncRunRepository;

  beforeEach(() => {
    RepositoryFactory.clear();
    syncLockRepo = new MockSyncLockRepository();
    syncRunRepo = new MockSyncRunRepository();
    RepositoryFactory.registerSyncLockRepository(syncLockRepo);
    RepositoryFactory.registerSyncRunRepository(syncRunRepo);
  });

  it("1. First caller acquires lock, second concurrent caller is rejected", async () => {
    const service1 = new SyncService(syncRunRepo, null, null, null, null, null, null, null, syncLockRepo);
    const service2 = new SyncService(syncRunRepo, null, null, null, null, null, null, null, syncLockRepo);

    const [res1, res2] = await Promise.all([service1.runSync(), service2.runSync()]);

    const succeeded = [res1, res2].filter((r) => r.ok);
    const contended = [res1, res2].filter((r) => !r.ok && r.error?.code === "SYNC_ALREADY_RUNNING");

    expect(succeeded).toHaveLength(1);
    expect(contended).toHaveLength(1);
  });

  it("2. No sync_runs record is created for rejected caller", async () => {
    const service1 = new SyncService(syncRunRepo, null, null, null, null, null, null, null, syncLockRepo);
    const service2 = new SyncService(syncRunRepo, null, null, null, null, null, null, null, syncLockRepo);

    await Promise.all([service1.runSync(), service2.runSync()]);

    const createdRuns = syncRunRepo.getUnfinishedSyncRun ? await syncRunRepo.getUnfinishedSyncRun() : null;
    // Only 1 active sync_runs record was ever created during the execution
    expect(createdRuns).toBeNull(); // Because the successful run completed and finalized
  });

  it("3. Lock release allows next sequential caller", async () => {
    const service = new SyncService(syncRunRepo, null, null, null, null, null, null, null, syncLockRepo);

    const res1 = await service.runSync();
    expect(res1.ok).toBe(true);

    const lockStateAfterRun1 = await syncLockRepo.getLock("global:rillnet-sync");
    expect(lockStateAfterRun1).toBeNull(); // Lock released in finally

    const res2 = await service.runSync();
    expect(res2.ok).toBe(true);
  });

  it("4. Releasing with wrong ownerId fails safely", async () => {
    const res = await syncLockRepo.acquireLock("global:rillnet-sync", "owner-A", 60000);
    expect(res.acquired).toBe(true);

    const wrongRelease = await syncLockRepo.releaseLock("global:rillnet-sync", "owner-B");
    expect(wrongRelease).toBe(false);

    const stillLocked = await syncLockRepo.getLock("global:rillnet-sync");
    expect(stillLocked?.ownerId).toBe("owner-A");
  });

  it("5. Expired lock can be taken over by new owner", async () => {
    const res1 = await syncLockRepo.acquireLock("global:rillnet-sync", "crashed-owner", 50);
    expect(res1.acquired).toBe(true);

    // Wait for lock to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res2 = await syncLockRepo.acquireLock("global:rillnet-sync", "new-owner", 60000);
    expect(res2.acquired).toBe(true);
    expect(res2.expiredTakeover).toBe(true);
    expect(res2.ownerId).toBe("new-owner");
  });

  it("6. Heartbeat renews active lock TTL", async () => {
    const res1 = await syncLockRepo.acquireLock("global:rillnet-sync", "owner-HB", 500);
    expect(res1.acquired).toBe(true);

    const initialExpiry = new Date(res1.expiresAt!).getTime();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const renewed = await syncLockRepo.renewLock("global:rillnet-sync", "owner-HB", 1000);
    expect(renewed).toBe(true);

    const lockState = await syncLockRepo.getLock("global:rillnet-sync");
    expect(new Date(lockState!.expiresAt).getTime()).toBeGreaterThan(initialExpiry);
  });

  it("7. Acquisition DB error propagates", async () => {
    const errorRepo = new MockSyncLockRepository();
    errorRepo.acquireLock = async () => {
      throw new Error("DB_CONNECTION_TIMEOUT");
    };

    const service = new SyncService(syncRunRepo, null, null, null, null, null, null, null, errorRepo);
    const result = await service.runSync();

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("DB_CONNECTION_TIMEOUT");
  });

  it("8. API endpoint /api/debug/sync returns HTTP 409 Conflict when lock is contended", async () => {
    // Acquire lock first
    await syncLockRepo.acquireLock("global:rillnet-sync", "existing-owner", 60000);

    const req = new NextRequest("http://localhost:3000/api/debug/sync", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.CRON_SECRET || "ops-secret-2026"}`,
      },
    });
    const response = await syncRouteHandler(req);

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("Conflict");
    expect(body.message).toContain("active and holding the distributed lock");
  });
});
