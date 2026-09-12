import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const syncRillnet = vi.fn();
const queue = vi.fn();
const claim = vi.fn();
const finish = vi.fn();
const persist = vi.fn();

vi.mock("@/security/api-security", () => ({ isCronAuthorized: () => true, authorizeApiRequest: vi.fn() }));
vi.mock("@/connectors/supabase", () => ({
  createAdminClient: () => ({
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }),
      }),
    })),
  }),
}));
vi.mock("@/jobs/sync-rillnet", () => ({ syncRillnet }));
vi.mock("@/services/checkpoint-recovery", () => ({ queueCheckpointRecovery: queue, claimCheckpointRecovery: claim, finishCheckpointRecovery: finish }));
vi.mock("@/services/checkpoint-dispatch-audit", () => ({ persistCheckpointDispatchAudit: persist }));
vi.mock("@/services/telegram-followup-pilot", () => ({ runTelegramFollowupPilotDispatch: vi.fn() }));
vi.mock("@/services/telegram-rillnet-review", () => ({ dispatchRillnetChangeReviews: vi.fn() }));
vi.mock("@/services/telegram-incident-status", () => ({ sendIncidentSyncStatus: vi.fn() }));

const failedBeforeSync = { ok: false, syncRunId: "", startedAt: "2026-09-12T01:00:00.000Z", completedAt: "2026-09-12T01:00:01.000Z", durationMs: 1, fetchedOrderCount: 0, normalizedOrderCount: 0, incidentCount: 0, phaseTimings: {}, dbInstrumentation: { totalQueries: 0, phases: {}, bottlenecksDetected: [] }, error: { code: "GatewayTimeout", message: "Gateway Timeout" } };

describe("checkpoint recovery wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("7. queues exactly one governed recovery after a transient pre-sync failure", async () => {
    syncRillnet.mockResolvedValue(failedBeforeSync);
    const { GET } = await import("@/app/api/cron/followup-cycle/route");
    const response = await GET(new NextRequest("https://opspilot.test/api/cron/followup-cycle"));
    expect(response.status).toBe(500);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failureStage: "SYNC_LOCK_ACQUISITION" }));
  });

  it("8. completes a claimed recovery after one effective sync", async () => {
    claim.mockResolvedValue(true);
    syncRillnet.mockResolvedValue({ ...failedBeforeSync, ok: true, syncRunId: "run-1", skipped: true, skipReason: "CHECKPOINT_ALREADY_COMPLETED", error: undefined });
    const { GET } = await import("@/app/api/cron/followup-cycle/route");
    const response = await GET(new NextRequest("https://opspilot.test/api/cron/followup-cycle?checkpoint_at=2026-09-12T01%3A00%3A00.000Z&recovery_attempt=1", { headers: { "x-opspilot-recovery-token": "token-1" } }));
    expect(response.status).toBe(200);
    expect(finish).toHaveBeenCalledWith(expect.anything(), "2026-09-12T01:00:00.000Z", "token-1", expect.objectContaining({ status: "SUCCEEDED", syncRunId: "run-1" }));
  });

  it("9. does not execute a duplicate recovery that cannot be claimed", async () => {
    claim.mockResolvedValue(false);
    const { GET } = await import("@/app/api/cron/followup-cycle/route");
    const response = await GET(new NextRequest("https://opspilot.test/api/cron/followup-cycle?checkpoint_at=2026-09-12T01%3A00%3A00.000Z&recovery_attempt=1", { headers: { "x-opspilot-recovery-token": "token-1" } }));
    expect(response.status).toBe(200);
    expect(syncRillnet).not.toHaveBeenCalled();
  });
});
