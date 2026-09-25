import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SyncRunRow } from "@/connectors/supabase/types";
import { SupabaseSyncRunRepository } from "@/repositories/supabase/SupabaseSyncRunRepository";
import { MockSyncRunRepository } from "@/repositories/mock/MockSyncRunRepository";

const { authorizeMock, createAdminClientMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  createAdminClientMock: vi.fn(),
}));

vi.mock("@/security/api-security", () => ({
  authorizeApiRequest: authorizeMock,
}));

vi.mock("@/connectors/supabase", () => ({
  createAdminClient: createAdminClientMock,
}));

import { GET } from "@/app/api/internal/diagnostics/sync-state/route";

function makeRequest() {
  return new NextRequest("https://opspilot.test/api/internal/diagnostics/sync-state", {
    headers: { authorization: "Bearer test-admin-token" },
  });
}

function createChainableBuilder(resolvedData: any) {
  const builder: any = {
    select: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockImplementation(() => Promise.resolve({ data: resolvedData, error: null })),
    then: (resolve: any, reject: any) => Promise.resolve({ data: resolvedData, error: null }).then(resolve, reject),
  };
  return builder;
}

describe("GET /api/internal/diagnostics/sync-state", () => {
  let unfinishedData: SyncRunRow[];
  let latestRunData: SyncRunRow | null;
  let lockData: { lock_key: string; expires_at: string } | null;
  let syncRunsCallCount: number;

  beforeEach(() => {
    vi.clearAllMocks();

    authorizeMock.mockResolvedValue({
      ok: true,
      identity: { actor: "admin@example.com", role: "ADMIN" },
    });

    unfinishedData = [];
    latestRunData = null;
    lockData = null;
    syncRunsCallCount = 0;

    createAdminClientMock.mockImplementation(() => ({
      from: vi.fn((table: string) => {
        if (table === "sync_runs") {
          syncRunsCallCount += 1;
          // First call is getUnfinishedSyncRuns(50), second is getLatestSyncRun()
          if (syncRunsCallCount === 1) {
            return createChainableBuilder(unfinishedData);
          }
          return createChainableBuilder(latestRunData);
        }
        if (table === "sync_locks") {
          return createChainableBuilder(lockData);
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    }));
  });

  it("MANAGE_SYSTEM authorized => 200", async () => {
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    expect(authorizeMock).toHaveBeenCalledWith(expect.anything(), "MANAGE_SYSTEM");

    const json = await response.json();
    expect(json.ok).toBe(true);
    expect(json.unfinishedCount).toBe(0);
    expect(json.unfinishedRuns).toEqual([]);
    expect(json.latestRun).toBeNull();
    expect(json.activeSyncLock).toBe(false);
    expect(json.lockExpiresAt).toBeNull();
  });

  it("unauthorized => rejected", async () => {
    authorizeMock.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "AUTHENTICATION_REQUIRED" }, { status: 401 }),
    });

    const response = await GET(makeRequest());
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error).toBe("AUTHENTICATION_REQUIRED");
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it("zero unfinished => unfinishedCount 0", async () => {
    unfinishedData = [];

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.unfinishedCount).toBe(0);
    expect(json.unfinishedRuns).toEqual([]);
  });

  it("failed non-COMPLETED => included", async () => {
    const failedRun: SyncRunRow = {
      id: "run-failed-1",
      started_at: "2026-09-25T12:00:00.000Z",
      completed_at: "2026-09-25T12:01:00.000Z",
      status: "failed",
      current_phase: "FAILED",
      fetched_order_count: 10,
      normalized_order_count: 5,
      incident_count: 1,
      duration_ms: 60000,
      error_message: "SECRET_DATABASE_FAILURE_MESSAGE",
      created_at: "2026-09-25T12:00:00.000Z",
    };
    unfinishedData = [failedRun];

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.unfinishedCount).toBe(1);
    expect(json.unfinishedRuns).toEqual([
      {
        id: "run-failed-1",
        status: "failed",
        currentPhase: "FAILED",
        startedAt: "2026-09-25T12:00:00.000Z",
        completedAt: "2026-09-25T12:01:00.000Z",
      },
    ]);
    // Ensure error_message is not exposed
    expect(JSON.stringify(json)).not.toContain("SECRET_DATABASE_FAILURE_MESSAGE");
  });

  it("running non-COMPLETED => included", async () => {
    const runningRun: SyncRunRow = {
      id: "run-running-1",
      started_at: "2026-09-25T13:00:00.000Z",
      completed_at: null,
      status: "running",
      current_phase: "PROCESSING_FOLLOWUPS",
      fetched_order_count: 50,
      normalized_order_count: 50,
      incident_count: 0,
      duration_ms: null,
      created_at: "2026-09-25T13:00:00.000Z",
    };
    unfinishedData = [runningRun];

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.unfinishedCount).toBe(1);
    expect(json.unfinishedRuns).toEqual([
      {
        id: "run-running-1",
        status: "running",
        currentPhase: "PROCESSING_FOLLOWUPS",
        startedAt: "2026-09-25T13:00:00.000Z",
        completedAt: null,
      },
    ]);
  });

  it("active lock correctly reported", async () => {
    const futureExpiresAt = new Date(Date.now() + 60_000).toISOString();
    lockData = { lock_key: "global:rillnet-sync", expires_at: futureExpiresAt };

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.activeSyncLock).toBe(true);
    expect(json.lockExpiresAt).toBe(futureExpiresAt);
  });

  it("expired lock not active", async () => {
    const pastExpiresAt = new Date(Date.now() - 60_000).toISOString();
    lockData = { lock_key: "global:rillnet-sync", expires_at: pastExpiresAt };

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.activeSyncLock).toBe(false);
    expect(json.lockExpiresAt).toBe(pastExpiresAt);
  });

  it("reports latestRun with durationMs and sanitized fields", async () => {
    latestRunData = {
      id: "run-latest-1",
      started_at: "2026-09-25T14:00:00.000Z",
      completed_at: "2026-09-25T14:05:00.000Z",
      status: "success",
      current_phase: "COMPLETED",
      fetched_order_count: 100,
      normalized_order_count: 100,
      incident_count: 0,
      duration_ms: 300000,
      error_message: "SECRET_SHOULD_NOT_LEAK",
      created_at: "2026-09-25T14:00:00.000Z",
    };

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.latestRun).toEqual({
      id: "run-latest-1",
      status: "success",
      currentPhase: "COMPLETED",
      startedAt: "2026-09-25T14:00:00.000Z",
      completedAt: "2026-09-25T14:05:00.000Z",
      durationMs: 300000,
    });
    expect(JSON.stringify(json)).not.toContain("SECRET_SHOULD_NOT_LEAK");
  });
});

describe("Repository Unfinished Predicate Tests", () => {
  it("SupabaseSyncRunRepository builds query with exact predicate", async () => {
    const orMock = vi.fn().mockReturnThis();
    const neqMock = vi.fn().mockReturnThis();
    const orderMock = vi.fn().mockReturnThis();
    const limitMock = vi.fn().mockResolvedValue({ data: [], error: null });
    const selectMock = vi.fn().mockReturnValue({
      or: orMock,
      neq: neqMock,
      order: orderMock,
      limit: limitMock,
    });
    const fromMock = vi.fn().mockReturnValue({ select: selectMock });

    const repo = new SupabaseSyncRunRepository({ from: fromMock } as any);
    const result = await repo.getUnfinishedSyncRuns(50);

    expect(fromMock).toHaveBeenCalledWith("sync_runs");
    expect(selectMock).toHaveBeenCalledWith("*");
    expect(orMock).toHaveBeenCalledWith("status.eq.running,status.eq.failed");
    expect(neqMock).toHaveBeenCalledWith("current_phase", "COMPLETED");
    expect(orderMock).toHaveBeenCalledWith("started_at", { ascending: false });
    expect(limitMock).toHaveBeenCalledWith(50);
    expect(result).toEqual([]);
  });

  it("MockSyncRunRepository filters correctly for all required semantics", async () => {
    const mockRepo = new MockSyncRunRepository();

    const runs: SyncRunRow[] = [
      // 1. success COMPLETED => excluded
      {
        id: "success-completed",
        started_at: "2026-09-25T10:00:00.000Z",
        completed_at: "2026-09-25T10:02:00.000Z",
        status: "success",
        current_phase: "COMPLETED",
        fetched_order_count: 10,
        normalized_order_count: 10,
        incident_count: 0,
        created_at: "2026-09-25T10:00:00.000Z",
      },
      // 2. failed but current_phase COMPLETED => excluded
      {
        id: "failed-completed",
        started_at: "2026-09-25T11:00:00.000Z",
        completed_at: "2026-09-25T11:02:00.000Z",
        status: "failed",
        current_phase: "COMPLETED",
        fetched_order_count: 10,
        normalized_order_count: 10,
        incident_count: 0,
        created_at: "2026-09-25T11:00:00.000Z",
      },
      // 3. failed non-COMPLETED => included
      {
        id: "failed-non-completed",
        started_at: "2026-09-25T12:00:00.000Z",
        completed_at: "2026-09-25T12:02:00.000Z",
        status: "failed",
        current_phase: "FAILED",
        fetched_order_count: 10,
        normalized_order_count: 10,
        incident_count: 0,
        created_at: "2026-09-25T12:00:00.000Z",
      },
      // 4. running non-COMPLETED => included
      {
        id: "running-non-completed",
        started_at: "2026-09-25T13:00:00.000Z",
        completed_at: null,
        status: "running",
        current_phase: "FETCHING_SNAPSHOT",
        fetched_order_count: 0,
        normalized_order_count: 0,
        incident_count: 0,
        created_at: "2026-09-25T13:00:00.000Z",
      },
    ];

    mockRepo.seed(runs);

    const unfinished = await mockRepo.getUnfinishedSyncRuns();
    expect(unfinished.length).toBe(2);
    // Order by started_at DESC
    expect(unfinished[0].id).toBe("running-non-completed");
    expect(unfinished[1].id).toBe("failed-non-completed");

    // Verify zero unfinished when only completed
    const emptyRepo = new MockSyncRunRepository();
    emptyRepo.seed([runs[0], runs[1]]);
    const zeroUnfinished = await emptyRepo.getUnfinishedSyncRuns();
    expect(zeroUnfinished.length).toBe(0);
  });
});
