import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { authorize, adminClient, queue, audit } = vi.hoisted(() => ({
  authorize: vi.fn(),
  adminClient: vi.fn(() => ({ marker: "service-role-client" })),
  queue: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/security/api-security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/security/api-security")>();
  return { ...actual, authorizeApiRequest: authorize };
});
vi.mock("@/connectors/supabase", () => ({ createAdminClient: adminClient }));
vi.mock("@/services/checkpoint-recovery", () => ({ queueCheckpointRecovery: queue }));

const runId = "dfd46c49-50e6-4cde-a7d3-1a16328537cf";
const checkpointAt = "2026-09-23T11:00:00.000Z";
const queued = {
  outcome: "QUEUED",
  code: null,
  syncRunId: runId,
  checkpointAt,
  recoveryStatus: "PENDING",
  recoveryAttempt: 0,
  tokenPresent: false,
};

async function post(body: unknown) {
  const { POST } = await import("@/app/api/internal/recovery/checkpoint/route");
  return POST(new NextRequest("https://opspilot.test/api/internal/recovery/checkpoint", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("stale checkpoint recovery operator route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorize.mockResolvedValue({ ok: true, identity: { actor: "owner@ops.test" } });
    queue.mockResolvedValue(queued);
    audit.mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(audit);
  });

  afterEach(() => vi.restoreAllMocks());

  it("queues only the UUID through the existing recovery helper", async () => {
    const response = await post({ syncRunId: runId });
    expect(response.status).toBe(202);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ marker: "service-role-client" }), { syncRunId: runId });
    const body = await response.json();
    expect(body).toMatchObject({ outcome: "QUEUED", syncRunId: runId, checkpointAt, recoveryStatus: "PENDING", tokenPresent: false });
    expect(body).not.toHaveProperty("recoveryToken");
  });

  it("returns idempotent success for the same run without creating another recovery", async () => {
    queue.mockResolvedValue({ ...queued, outcome: "ALREADY_QUEUED", recoveryStatus: "PENDING" });
    const response = await post({ syncRunId: runId });
    expect(response.status).toBe(200);
    expect((await response.json()).outcome).toBe("ALREADY_QUEUED");
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it("maps active lease and completed-run validation failures to a safe conflict", async () => {
    queue.mockResolvedValueOnce({ ...queued, outcome: "REJECTED", code: "SYNC_LEASE_ACTIVE" });
    const activeLease = await post({ syncRunId: runId });
    expect(activeLease.status).toBe(409);
    expect((await activeLease.json()).code).toBe("SYNC_LEASE_ACTIVE");

    queue.mockResolvedValueOnce({ ...queued, outcome: "REJECTED", code: "RUN_NOT_RESUMABLE" });
    const finalized = await post({ syncRunId: runId });
    expect(finalized.status).toBe(409);
    expect((await finalized.json()).code).toBe("RUN_NOT_RESUMABLE");
  });

  it("maps an unknown run to 404", async () => {
    queue.mockResolvedValue({ ...queued, outcome: "REJECTED", code: "RUN_NOT_FOUND" });
    const response = await post({ syncRunId: runId });
    expect(response.status).toBe(404);
  });

  it("rejects arbitrary checkpoint fields and malformed UUIDs before queueing", async () => {
    const injected = await post({ syncRunId: runId, checkpointAt });
    expect(injected.status).toBe(400);
    const malformed = await post({ syncRunId: "not-a-uuid" });
    expect(malformed.status).toBe(400);
    expect(queue).not.toHaveBeenCalled();
  });

  it("requires MANAGE_SYSTEM and never exposes raw recovery data", async () => {
    authorize.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "PERMISSION_DENIED" }, { status: 403 }) });
    const response = await post({ syncRunId: runId });
    expect(response.status).toBe(403);
    expect(authorize).toHaveBeenCalledWith(expect.anything(), "MANAGE_SYSTEM", { limit: 5, windowMs: 60_000 });
    expect(queue).not.toHaveBeenCalled();
  });
});
