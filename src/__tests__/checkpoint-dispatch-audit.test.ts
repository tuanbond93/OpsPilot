import { describe, expect, it, vi } from "vitest";
import { persistCheckpointDispatchAudit } from "@/services/checkpoint-dispatch-audit";

function client(error: unknown = null) {
  const insert = vi.fn().mockResolvedValue({ error });
  return { from: vi.fn(() => ({ insert })) } as any;
}

describe("checkpoint dispatch audit persistence", () => {
  it("writes zero-valued counters for a successful zero-result checkpoint", async () => {
    const supabase = client();
    await persistCheckpointDispatchAudit(supabase, { checkpointAt: "2026-09-10T03:00:00.000Z", startedAt: "2026-09-10T03:00:01.000Z", completedAt: "2026-09-10T03:00:02.000Z", executionStatus: "SUCCESS" });
    expect(supabase.from().insert).toHaveBeenCalledWith(expect.objectContaining({ total_dispatch_eligible_pending: 0, telegram_scanned: 0, send_success: 0 }));
  });

  it("treats a duplicate checkpoint as idempotent", async () => {
    await expect(persistCheckpointDispatchAudit(client({ code: "23505" }), { checkpointAt: "2026-09-10T03:00:00.000Z", startedAt: "2026-09-10T03:00:01.000Z", completedAt: "2026-09-10T03:00:02.000Z", executionStatus: "SUCCESS" })).resolves.toBeUndefined();
  });

  it("does not hide non-duplicate persistence errors", async () => {
    await expect(persistCheckpointDispatchAudit(client({ code: "42P01", message: "missing table" }), { checkpointAt: "2026-09-10T03:00:00.000Z", startedAt: "2026-09-10T03:00:01.000Z", completedAt: "2026-09-10T03:00:02.000Z", executionStatus: "FAILED" })).rejects.toMatchObject({ code: "42P01" });
  });
});
