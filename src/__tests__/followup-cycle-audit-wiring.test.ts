import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const syncRillnet = vi.fn();
const dispatch = vi.fn();
const sendStatus = vi.fn();
const persist = vi.fn();
const queuePhase2 = vi.fn();
const slowPhase2 = vi.fn();

vi.mock("@/security/api-security", () => ({ isCronAuthorized: () => true, authorizeApiRequest: vi.fn() }));
vi.mock("@/connectors/supabase", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/jobs/sync-rillnet", () => ({ syncRillnet }));
vi.mock("@/services/telegram-followup-pilot", () => ({ runTelegramFollowupPilotDispatch: dispatch }));
vi.mock("@/services/telegram-rillnet-review", () => ({ dispatchRillnetChangeReviews: vi.fn().mockResolvedValue({ scanned: 0, sent: 0, failed: 0 }) }));
vi.mock("@/services/telegram-incident-status", () => ({ sendIncidentSyncStatus: sendStatus }));
vi.mock("@/services/checkpoint-dispatch-audit", () => ({ persistCheckpointDispatchAudit: persist }));
vi.mock("@/services/phase2-checkpoint-work", () => ({ queuePhase2CheckpointWork: queuePhase2 }));
vi.mock("@/services/near-term-capacity-runtime", () => ({ NearTermCapacityRuntimeService: class { runCheckpoint = slowPhase2; } }));

const sync = {
  ok: true, syncRunId: "00000000-0000-4000-8000-000000000001", startedAt: "2026-09-10T07:00:01.000Z", completedAt: "2026-09-10T07:01:00.000Z",
  skipped: true, skipReason: "SOURCE_UNCHANGED",
};

describe("followup checkpoint audit wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes exactly one final audit with the status summary from a no-fresh checkpoint", async () => {
    syncRillnet.mockResolvedValue(sync);
    dispatch.mockResolvedValue({ scanned: 0, sent: 0, failed: 0 });
    sendStatus.mockResolvedValue({ active: 105, resolved: 5, sentBatches: 7, failed: 0 });
    persist.mockResolvedValue(undefined);
    const { GET } = await import("@/app/api/cron/followup-cycle/route");

    const response = await GET(new NextRequest("https://opspilot.test/api/cron/followup-cycle"));

    expect(response.status).toBe(200);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      telegramScanned: 0, sendSuccess: 0, sendFailed: 0,
      statusUpdatesActive: 105, statusUpdatesResolved: 5, statusUpdateBatchesSent: 7, statusUpdateBatchesFailed: 0,
    }));
  });

  it("does not let an audit persistence failure fail an otherwise successful sync", async () => {
    syncRillnet.mockResolvedValue(sync);
    sendStatus.mockResolvedValue({ active: 0, resolved: 0, sentBatches: 0, failed: 0 });
    persist.mockRejectedValue(new Error("audit unavailable"));
    const { GET } = await import("@/app/api/cron/followup-cycle/route");

    const response = await GET(new NextRequest("https://opspilot.test/api/cron/followup-cycle"));

    expect(response.status).toBe(200);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("returns primary success without awaiting a slow Phase2 runtime", async () => {
    syncRillnet.mockResolvedValue({ ...sync, skipped: false, skipReason: undefined, followupEvaluation: { supportedCasesEvaluated: 1, khoTonEvaluated: 1, khoChuaLuanChuyenEvaluated: 0, pendingCreated: { first: 0, second: 0, third: 0, escalation: 0 } } });
    dispatch.mockResolvedValue({ scanned: 1, recipientsResolved: 1, interactionsCreated: 0, sendAttempts: 0, sent: 0, failed: 0 });
    sendStatus.mockResolvedValue({ active: 1, resolved: 0, sentBatches: 1, failed: 0 });
    persist.mockResolvedValue(undefined);
    queuePhase2.mockResolvedValue(undefined);
    slowPhase2.mockImplementation(() => new Promise(() => undefined));
    const { GET } = await import("@/app/api/cron/followup-cycle/route");
    const started = Date.now();
    const response = await GET(new NextRequest("https://opspilot.test/api/cron/followup-cycle"));
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(queuePhase2).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ syncRunId: sync.syncRunId }));
    expect(slowPhase2).not.toHaveBeenCalled();
  });
});
