import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const claim = vi.fn();
const finish = vi.fn();
const outcome = vi.fn();
const runCheckpoint = vi.fn();

vi.mock("@/security/api-security", () => ({ isCronAuthorized: () => true, authorizeApiRequest: vi.fn() }));
vi.mock("@/connectors/supabase", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/services/phase2-checkpoint-work", () => ({
  claimPhase2CheckpointWork: claim, finishPhase2CheckpointWork: finish, phase2FailureOutcome: outcome,
}));
vi.mock("@/services/near-term-capacity-runtime", () => ({
  NearTermCapacityRuntimeService: class { runCheckpoint = runCheckpoint; },
}));

const request = () => new NextRequest("https://opspilot.test/api/cron/phase2-checkpoint?checkpoint_at=2026-09-15T01%3A00%3A00.000Z", { headers: { "x-opspilot-phase2-token": "token-1" } });

describe("Phase2 checkpoint dispatcher route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs the unchanged candidate path only after an atomic claim", async () => {
    claim.mockResolvedValue({ sync_run_id: "run-1" });
    runCheckpoint.mockResolvedValue({ status: "FACT_REQUEST_SENT", risk_candidates: 1, fact_requests_sent: 1 });
    const { GET } = await import("@/app/api/cron/phase2-checkpoint/route");
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(runCheckpoint).toHaveBeenCalledWith("phase2_checkpoint", { checkpointAt: "2026-09-15T01:00:00.000Z", syncRunId: "run-1" });
    expect(finish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: "COMPLETED" }));
  });

  it("persists a bounded retry separately when Phase2 has a transient failure", async () => {
    claim.mockResolvedValue({ sync_run_id: "run-1" });
    runCheckpoint.mockRejectedValue(new Error("Gateway Timeout"));
    outcome.mockReturnValue("RETRYABLE");
    const { GET } = await import("@/app/api/cron/phase2-checkpoint/route");
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(finish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: "RETRYABLE" }));
  });

  it("does not execute a duplicate dispatcher request", async () => {
    claim.mockResolvedValue(null);
    const { GET } = await import("@/app/api/cron/phase2-checkpoint/route");
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(runCheckpoint).not.toHaveBeenCalled();
  });
});
