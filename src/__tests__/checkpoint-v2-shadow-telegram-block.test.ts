import { describe, expect, it, vi } from "vitest";
import { CheckpointDispatchLedger, InMemoryDispatchLedgerStorage } from "@/engine/checkpoint-v2/dispatch-ledger";
import { CheckpointShadowRunner } from "@/engine/checkpoint-v2/checkpoint-shadow-runner";

describe("Checkpoint Pipeline V2 - Shadow Telegram Defense-In-Depth Hard Block", () => {
  const CHECKPOINT_AT = "2026-09-26T14:00:00.000Z";
  const SYNC_RUN_ID = "6c6b3a71-8df7-4042-8e30-659767b723e7";

  it("strictly blocks external send and produces 0 external calls in SHADOW mode even if real adapter is passed", async () => {
    const storage = new InMemoryDispatchLedgerStorage();
    const ledger = new CheckpointDispatchLedger(storage);

    // Mock real Telegram adapter that would send HTTP network request to Telegram Bot API
    const realTelegramAdapterSpy = vi.fn().mockImplementation(async () => {
      // If this is ever called, it represents a fatal leak of shadow execution to live operator channels
      throw new Error("FATAL_LEAK: Real Telegram Bot API was contacted during SHADOW execution!");
    });

    const result = await ledger.dispatchEffectivelyOnce({
      checkpointAt: CHECKPOINT_AT,
      syncRunId: SYNC_RUN_ID,
      caseId: "case_001",
      incidentKey: "WH_HNI_01:SKU_001",
      interventionType: "TELEGRAM_FIRST_PUSH",
      sequence: 1,
      executionMode: "SHADOW",
      sendExternal: realTelegramAdapterSpy,
    });

    // 1. Verify dispatch status is SHADOW_SUPPRESSED
    expect(result.status).toBe("SHADOW_SUPPRESSED");
    expect(result.messageId).toContain("SHADOW_SUPPRESSED");

    // 2. Verify real Telegram adapter was NEVER invoked
    expect(realTelegramAdapterSpy).not.toHaveBeenCalled();

    // 3. Verify ledger entry is marked CONFIRMED with synthetic shadow message ID
    const entry = await storage.getByDedupeKey(
      CheckpointDispatchLedger.buildIdempotencyKey(CHECKPOINT_AT, "case_001", "TELEGRAM_FIRST_PUSH", 1)
    );
    expect(entry).not.toBeNull();
    expect(entry?.status).toBe("CONFIRMED");
    expect(entry?.executionMode).toBe("SHADOW");
    expect(entry?.telegramMessageId).toContain("SHADOW_SUPPRESSED");

    // Formal assertion: SHADOW_EXTERNAL_TELEGRAM_CALLS = 0
    const shadowExternalTelegramCalls = realTelegramAdapterSpy.mock.calls.length;
    expect(shadowExternalTelegramCalls).toBe(0);
  });

  it("permits external send when executionMode is PRODUCTION", async () => {
    const storage = new InMemoryDispatchLedgerStorage();
    const ledger = new CheckpointDispatchLedger(storage);

    const liveTelegramAdapter = vi.fn().mockResolvedValue({
      telegramMessageId: "tg_msg_live_99999",
    });

    const result = await ledger.dispatchEffectivelyOnce({
      checkpointAt: CHECKPOINT_AT,
      syncRunId: SYNC_RUN_ID,
      caseId: "case_002",
      incidentKey: "WH_SGN_01:SKU_002",
      interventionType: "TELEGRAM_FIRST_PUSH",
      sequence: 1,
      executionMode: "PRODUCTION",
      sendExternal: liveTelegramAdapter,
    });

    expect(result.status).toBe("SENT");
    expect(result.messageId).toBe("tg_msg_live_99999");
    expect(liveTelegramAdapter).toHaveBeenCalledTimes(1);
  });

  it("shadow runner suppresses all 47 simulated cases with 0 external network requests", async () => {
    const runner = new CheckpointShadowRunner();

    const report = await runner.runShadowComparison(
      {
        syncRunId: SYNC_RUN_ID,
        checkpointAt: CHECKPOINT_AT,
        orderCount: 6_293,
        incidentCount: 1_600,
        caseCount: 47,
        memberCount: 1_250,
        decisionsCount: 47,
        interventionTypes: ["TELEGRAM_FIRST_PUSH"],
      },
      Array.from({ length: 6_293 }, (_, i) => ({
        id: `ord_${i}`,
        orderCode: `ORD_${i}`,
        status: "storing",
        taskCategory: "storing",
        warehouseId: "WH_01",
        warehouseName: "Hub 1",
        customerId: "CUST_1",
        customerName: "Khach 1",
        customerCode: "C_1",
        createdAt: "2026-09-26T00:00:00Z",
        deliverWarehouseId: "WH_02",
        warehouseLog: [],
        endPickAt: "2026-09-26T06:00:00Z",
        fetchedAt: "2026-09-26T07:00:00Z",
      }))
    );

    expect(report.isShadow).toBe(true);
    expect(report.v2Summary.telegramSuppressedCount).toBe(47);
    expect(report.parity.overallParity).toBe(true);
  });
});
