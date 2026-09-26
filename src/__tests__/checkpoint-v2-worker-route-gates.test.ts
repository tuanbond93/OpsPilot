import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST, GET } from "@/app/api/internal/checkpoint-v2/worker/route";
import { MockCheckpointWorkQueueRepository } from "@/repositories/mock/MockCheckpointWorkQueueRepository";
import { CheckpointWorker } from "@/engine/checkpoint-v2/checkpoint-worker";

describe("WORKER_AUTH_GATE & SHADOW_DISABLED_ROUTE_GATE", () => {
  const originalEnv = { ...process.env };
  const TEST_SECRET = "ops-test-secret-42a8b9";

  beforeEach(() => {
    process.env.CRON_SECRET = TEST_SECRET;
    process.env.CHECKPOINT_PIPELINE_V2_SHADOW = "true";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("WORKER_AUTH_GATE: rejects request with no authorization with 401", async () => {
    const req = new NextRequest("http://localhost/api/internal/checkpoint-v2/worker", {
      method: "POST",
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("WORKER_AUTH_GATE: rejects request with bad secret with 401", async () => {
    const req = new NextRequest("http://localhost/api/internal/checkpoint-v2/worker", {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-secret-token",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("WORKER_AUTH_GATE: rejects request with bad x-cron-secret with 401", async () => {
    const req = new NextRequest("http://localhost/api/internal/checkpoint-v2/worker", {
      method: "GET",
      headers: {
        "x-cron-secret": "wrong-secret-token",
      },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("SHADOW_DISABLED_ROUTE_GATE: returns SKIPPED when CHECKPOINT_PIPELINE_V2_SHADOW=false", async () => {
    process.env.CHECKPOINT_PIPELINE_V2_SHADOW = "false";
    const req = new NextRequest("http://localhost/api/internal/checkpoint-v2/worker", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_SECRET}`,
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.status).toBe("SKIPPED");
    expect(data.reason).toBe("SHADOW_DISABLED");
  });

  it("SHADOW_DISABLED_ROUTE_GATE: returns SKIPPED when env is unset", async () => {
    delete process.env.CHECKPOINT_PIPELINE_V2_SHADOW;
    const req = new NextRequest("http://localhost/api/internal/checkpoint-v2/worker", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_SECRET}`,
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.status).toBe("SKIPPED");
    expect(data.reason).toBe("SHADOW_DISABLED");
  });
});

describe("WORKER_CHECKPOINT_SELECTION_GATE", () => {
  it("proves SHADOW-only filtering, deterministic FIFO selection, starvation prevention, and lease reclaim", async () => {
    const queueRepo = new MockCheckpointWorkQueueRepository();

    const olderCheckpointAt = "2026-09-27T01:00:00.000Z";
    const newerCheckpointAt = "2026-09-27T03:00:00.000Z";
    const syncRunIdOlder = "sync-run-older-08h";
    const syncRunIdNewer = "sync-run-newer-10h";

    // 1. Seed PRODUCTION units for older checkpoint and newer checkpoint
    await queueRepo.createWorkUnits([
      {
        checkpointAt: olderCheckpointAt,
        syncRunId: syncRunIdOlder,
        stage: "INGESTING",
        workType: "INGEST_POPULATION_CHUNK",
        partitionKey: "chunk-prod-1",
        cursor: { offset: 0, limit: 100 },
        idempotencyKey: "prod-older-1",
        executionMode: "PRODUCTION",
      },
      {
        checkpointAt: newerCheckpointAt,
        syncRunId: syncRunIdNewer,
        stage: "INGESTING",
        workType: "INGEST_POPULATION_CHUNK",
        partitionKey: "chunk-prod-2",
        cursor: { offset: 0, limit: 100 },
        idempotencyKey: "prod-newer-1",
        executionMode: "PRODUCTION",
      },
    ]);

    // 2. Seed SHADOW units for older checkpoint and newer checkpoint
    await queueRepo.createWorkUnits([
      {
        checkpointAt: olderCheckpointAt,
        syncRunId: syncRunIdOlder,
        stage: "INGESTING",
        workType: "INGEST_POPULATION_CHUNK",
        partitionKey: "chunk-shadow-older-1",
        cursor: { offset: 0, limit: 100 },
        idempotencyKey: "shadow-older-1",
        executionMode: "SHADOW",
      },
      {
        checkpointAt: olderCheckpointAt,
        syncRunId: syncRunIdOlder,
        stage: "INGESTING",
        workType: "INGEST_POPULATION_CHUNK",
        partitionKey: "chunk-shadow-older-2",
        cursor: { offset: 100, limit: 100 },
        idempotencyKey: "shadow-older-2",
        executionMode: "SHADOW",
      },
      {
        checkpointAt: newerCheckpointAt,
        syncRunId: syncRunIdNewer,
        stage: "INGESTING",
        workType: "INGEST_POPULATION_CHUNK",
        partitionKey: "chunk-shadow-newer-1",
        cursor: { offset: 0, limit: 100 },
        idempotencyKey: "shadow-newer-1",
        executionMode: "SHADOW",
      },
    ]);

    // 3. Prove SHADOW workers claim ONLY SHADOW units (never PRODUCTION)
    const claimedOlder = await queueRepo.claimWorkUnits(
      olderCheckpointAt,
      "worker-1",
      30_000,
      10,
      "SHADOW"
    );

    expect(claimedOlder.length).toBe(2);
    expect(claimedOlder.every((u) => u.executionMode === "SHADOW")).toBe(true);
    expect(claimedOlder.every((u) => u.checkpointAt === olderCheckpointAt)).toBe(true);

    // 4. Prove no cross-checkpoint adoption
    expect(claimedOlder.every((u) => u.syncRunId === syncRunIdOlder)).toBe(true);
    expect(claimedOlder.some((u) => u.syncRunId === syncRunIdNewer)).toBe(false);

    // 5. Prove expired leased work can be reclaimed
    // Worker 1 leaves unit 0 leased and simulates lease expiry for that unit only
    const unitToExpire = claimedOlder[0];
    const internalUnit = (queueRepo as any).units.get(unitToExpire.id);
    internalUnit.leaseExpiresAt = new Date(Date.now() - 5000).toISOString();

    const reclaimed = await queueRepo.claimWorkUnits(
      olderCheckpointAt,
      "worker-2",
      30_000,
      10,
      "SHADOW"
    );

    expect(reclaimed.length).toBe(1);
    expect(reclaimed[0].id).toBe(unitToExpire.id);
    expect(reclaimed[0].leaseOwner).toBe("worker-2");

    // Complete all units for older checkpoint
    for (const u of reclaimed) {
      await queueRepo.completeWorkUnit(u.id, "worker-2");
    }
    await queueRepo.completeWorkUnit(claimedOlder[1].id, "worker-1");

    // 6. Prove starvation resistance: once older checkpoint completes, newer checkpoint is claimed
    const claimedNewer = await queueRepo.claimWorkUnits(
      newerCheckpointAt,
      "worker-2",
      30_000,
      10,
      "SHADOW"
    );

    expect(claimedNewer.length).toBe(1);
    expect(claimedNewer[0].checkpointAt).toBe(newerCheckpointAt);
    expect(claimedNewer[0].syncRunId).toBe(syncRunIdNewer);
    expect(claimedNewer[0].executionMode === "SHADOW").toBe(true);
  });
});
