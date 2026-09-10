import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const syncRillnet = vi.fn();
const dispatch = vi.fn();
const sendStatus = vi.fn();
const persist = vi.fn();

vi.mock("@/security/api-security", () => ({ isCronAuthorized: () => true, authorizeApiRequest: vi.fn() }));
vi.mock("@/connectors/supabase", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/jobs/sync-rillnet", () => ({ syncRillnet }));
vi.mock("@/services/telegram-followup-pilot", () => ({ runTelegramFollowupPilotDispatch: dispatch }));
vi.mock("@/services/telegram-rillnet-review", () => ({ dispatchRillnetChangeReviews: vi.fn().mockResolvedValue({ scanned: 0, sent: 0, failed: 0 }) }));
vi.mock("@/services/telegram-incident-status", () => ({ sendIncidentSyncStatus: sendStatus }));
vi.mock("@/services/checkpoint-dispatch-audit", () => ({ persistCheckpointDispatchAudit: persist }));

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
});
