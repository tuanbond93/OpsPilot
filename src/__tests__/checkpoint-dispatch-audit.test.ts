import { describe, expect, it, vi } from "vitest";
import { persistCheckpointDispatchAudit } from "@/services/checkpoint-dispatch-audit";

function client(error: unknown = null) {
  const insert = vi.fn().mockResolvedValue({ error });
  return { from: vi.fn(() => ({ insert })) } as any;
}

describe("checkpoint dispatch audit persistence", () => {
  it("writes zero-valued counters for a successful zero-result checkpoint", async () => {
    const supabase = client();
    await persistCheckpointDispatchAudit(supabase, {
      checkpointAt: "2026-09-10T03:00:00.000Z", startedAt: "2026-09-10T03:00:01.000Z", completedAt: "2026-09-10T03:00:02.000Z", executionStatus: "SUCCESS",
      totalDispatchEligiblePending: 0, telegramScanned: 0, sendSuccess: 0,
    });
    expect(supabase.from().insert).toHaveBeenCalledWith(expect.objectContaining({ total_dispatch_eligible_pending: 0, telegram_scanned: 0, send_success: 0, status_updates_active: null }));
  });

  it("persists the complete status-update and Telegram funnel for this checkpoint", async () => {
    const supabase = client();
    await persistCheckpointDispatchAudit(supabase, {
      checkpointAt: "2026-09-10T07:00:00.000Z", startedAt: "2026-09-10T07:00:01.000Z", completedAt: "2026-09-10T07:01:10.000Z", executionStatus: "SUCCESS",
      statusUpdatesActive: 105, statusUpdatesResolved: 5, statusUpdateBatchesSent: 7, statusUpdateBatchesFailed: 0,
      telegramScanned: 12, recipientsResolved: 8, interactionsCreated: 8, sendAttempts: 8, sendSuccess: 8, sendFailed: 0,
    });
    expect(supabase.from().insert).toHaveBeenCalledWith(expect.objectContaining({
      status_updates_active: 105, status_updates_resolved: 5, status_update_batches_sent: 7, status_update_batches_failed: 0,
      telegram_scanned: 12, recipients_resolved: 8, interactions_created: 8, send_attempts: 8, send_success: 8, send_failed: 0,
    }));
  });

  it("preserves unavailable counters as NULL instead of defaulting them to zero", async () => {
    const supabase = client();
    await persistCheckpointDispatchAudit(supabase, { checkpointAt: "2026-09-10T07:00:00.000Z", startedAt: "2026-09-10T07:00:01.000Z", completedAt: "2026-09-10T07:01:10.000Z", executionStatus: "FAILED", telegramScanned: null });
    expect(supabase.from().insert).toHaveBeenCalledWith(expect.objectContaining({ telegram_scanned: null, send_success: null, status_updates_active: null }));
  });

  it("treats a duplicate checkpoint as idempotent", async () => {
    await expect(persistCheckpointDispatchAudit(client({ code: "23505" }), { checkpointAt: "2026-09-10T03:00:00.000Z", startedAt: "2026-09-10T03:00:01.000Z", completedAt: "2026-09-10T03:00:02.000Z", executionStatus: "SUCCESS" })).resolves.toBeUndefined();
  });

  it("does not hide non-duplicate persistence errors", async () => {
    await expect(persistCheckpointDispatchAudit(client({ code: "42P01", message: "missing table" }), { checkpointAt: "2026-09-10T03:00:00.000Z", startedAt: "2026-09-10T03:00:01.000Z", completedAt: "2026-09-10T03:00:02.000Z", executionStatus: "FAILED" })).rejects.toMatchObject({ code: "42P01" });
  });
});
