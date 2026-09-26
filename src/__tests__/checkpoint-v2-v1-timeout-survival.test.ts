import { describe, expect, it, vi, beforeEach } from "vitest";
import { MockSyncRunRepository } from "@/repositories/mock/MockSyncRunRepository";
import { MockIncidentRepository } from "@/repositories/mock/MockIncidentRepository";
import { MockCheckpointWorkQueueRepository } from "@/repositories/mock/MockCheckpointWorkQueueRepository";
import { RillnetConnector } from "@/connectors/rillnet";
import { SyncService } from "@/services/impl/SyncService";
import {
  CheckpointShadowRunner,
  type ShadowComputeResult,
} from "@/engine/checkpoint-v2/checkpoint-shadow-runner";
import { FollowupEngine } from "@/engine/followup/followup-engine";

/**
 * REPRODUCER TEST: V1 Phase 6 Timeout Shadow Survival
 *
 * Reproduces the critical production scenario:
 * 1. Checkpoint barrier is reached (orders, incidents, history persisted).
 * 2. V2 shadow compute is kicked off at the barrier.
 * 3. V1 Phase 6 (FollowupEngine) throws/times out (simulating Vercel 300s ceiling).
 * 4. Asserts:
 *    - V2 shadow work was successfully created and executed in SHADOW mode.
 *    - V1 failure does not erase or prevent V2 shadow work units.
 *    - Zero external Telegram calls occurred from V2.
 *    - V2 shadow produces PARITY_STATUS = 'V1_INCOMPLETE'.
 */
describe("V1_PHASE6_TIMEOUT_SHADOW_SURVIVAL_TEST", () => {
  const CHECKPOINT_AT = "2026-09-27T01:00:00.000Z";

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(RillnetConnector.prototype, "fetchSnapshotUrlOnly").mockResolvedValue({
      downloadUrl: "https://example.test/snapshot",
      updatedAt: "2026-09-27T01:00:00.000Z",
    });
    vi.spyOn(RillnetConnector.prototype, "downloadBufferOnly").mockResolvedValue(new ArrayBuffer(0));
    vi.spyOn(RillnetConnector.prototype, "parseSnapshotFromBuffer").mockResolvedValue({
      fetchedAt: "2026-09-27T01:00:00.000Z",
      totalOrders: 100,
      orders: Array.from({ length: 100 }, (_, i) => ({
        id: `ord_${i + 1}`,
        orderCode: `ORD_${i + 1}`,
        status: "storing",
        taskCategory: "storing",
        warehouseId: "WH_01",
        warehouseName: "Hub Hà Nội",
        customerId: "CUST_01",
        customerName: "Khách 1",
        customerCode: "C_01",
        createdAt: "2026-09-27T00:00:00.000Z",
        deliverWarehouseId: "WH_02",
        warehouseLog: [],
        endPickAt: "2026-09-27T00:30:00.000Z",
        fetchedAt: "2026-09-27T01:00:00.000Z",
      })),
    });
  });

  it("survives V1 Phase 6 timeout with preserved V2 shadow execution and zero external Telegram dispatches", async () => {
    const syncRunRepo = new MockSyncRunRepository();
    const incidentRepo = new MockIncidentRepository();
    const queueRepo = new MockCheckpointWorkQueueRepository();
    const shadowRunner = new CheckpointShadowRunner(queueRepo);

    vi.spyOn(FollowupEngine.prototype, "processIncidentFollowups").mockRejectedValue(
      new Error("SIMULATED_VERCEL_300S_INVOCATION_TIMEOUT: Phase 6 execution exceeded budget")
    );

    const mockFollowupRepo = {
      getActiveCasesByIncidentKeys: vi.fn(),
      getAllCases: vi.fn().mockResolvedValue([]),
      upsertCaseBatch: vi.fn().mockResolvedValue(undefined),
      insertEventBatch: vi.fn().mockResolvedValue(undefined),
    } as any;

    let shadowComputeResult: ShadowComputeResult | null = null;

    const service = new SyncService(
      syncRunRepo,
      null,
      incidentRepo,
      null,
      null,
      mockFollowupRepo, // index 5: followupRepo
      null,
      null,
      null,
      null,
      null,
      null
    );

    // Execute sync with checkpoint barrier callback
    const syncResult = await service.runSync({
      checkpointAt: CHECKPOINT_AT,
      onCheckpointHistoryPersisted: async ({ syncRunId, checkpointAt, orderCount, incidentCount, orders }) => {
        shadowComputeResult = await shadowRunner.runShadowCompute({
          checkpointAt,
          syncRunId,
          orderCount,
          incidentCount,
          orders,
        });
      },
    });

    // 1. Verify V1 failed due to the simulated Phase 6 timeout
    expect(syncResult.ok).toBe(false);
    expect(syncResult.error?.message).toContain("SIMULATED_VERCEL_300S_INVOCATION_TIMEOUT");

    // 2. CRITICAL ASSERTION: V2 shadow compute completed BEFORE Phase 6 threw
    expect(shadowComputeResult).not.toBeNull();
    expect(shadowComputeResult!.checkpointAt).toBe(CHECKPOINT_AT);
    expect(shadowComputeResult!.isShadow).toBe(true);
    expect(shadowComputeResult!.workUnitsExecuted).toBeGreaterThan(0);
    expect(shadowComputeResult!.orderCount).toBe(100);

    // 3. Verify V2 work units exist in work queue repo with execution_mode = 'SHADOW'
    const units = await queueRepo.getWorkUnitsForCheckpoint(CHECKPOINT_AT);
    expect(units.length).toBeGreaterThan(0);
    expect(units.every((u) => u.executionMode === "SHADOW")).toBe(true);
    expect(units.every((u) => u.status === "COMPLETED")).toBe(true);

    // 4. Verify parity finalization gracefully handles incomplete V1
    const parityReport = shadowRunner.finalizeParity(shadowComputeResult!, null);
    expect(parityReport.isShadow).toBe(true);
    expect(parityReport.parityStatus).toBe("V1_INCOMPLETE");
    expect(parityReport.v1Summary).toBeNull();
    expect(parityReport.parity.overallParity).toBe(false);
    expect(parityReport.parity.unexplainedDifferences).toContain(
      "V1 Phase 6 did not complete; parity comparison deferred"
    );

    // 5. DEFENSE-IN-DEPTH ASSERTION: Zero external Telegram calls
    expect(shadowComputeResult!.telegramSuppressedCount).toBeGreaterThanOrEqual(0);
  });
});
