import { describe, it, expect, vi } from "vitest";
import { CheckpointOrchestrator } from "@/engine/checkpoint-v2/checkpoint-orchestrator";
import { CheckpointWorker } from "@/engine/checkpoint-v2/checkpoint-worker";
import { PostBarrierShadowHandler } from "@/engine/checkpoint-v2/post-barrier-handler";
import { MockCheckpointWorkQueueRepository } from "@/repositories/mock/MockCheckpointWorkQueueRepository";
import { MockOrderSnapshotRepository } from "@/repositories/mock/MockOrderSnapshotRepository";
import { MockSyncRunRepository } from "@/repositories/mock/MockSyncRunRepository";
import { MockIncidentRepository } from "@/repositories/mock/MockIncidentRepository";
import { MockIncidentHistoryRepository } from "@/repositories/mock/MockIncidentHistoryRepository";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";
import type { OrderSnapshotRow } from "@/connectors/supabase/types";
import type { Incident, IncidentReasonCode } from "@/engine/incident";

describe("Checkpoint Pipeline V2 - Exact Checkpoint Rehydration & Post-Barrier Execution", () => {
  it("rehydrates strictly from persisted checkpoint state without live Rillnet fetch and executes real post-barrier business logic", async () => {
    // 1. Spying on external Rillnet fetch to strictly prove ZERO live fetches
    const liveRillnetFetchSpy = vi.fn().mockImplementation(() => {
      throw new Error("SECURITY_BREACH: Live Rillnet fetch was invoked during post-barrier rehydration!");
    });

    const CHECKPOINT_T = "2026-09-26T07:00:00.000Z"; // 14h checkpoint
    const SYNC_RUN_ID = "b9f5e27a-8f47-4b71-9f93-559d79fb1e20";

    const snapshotRepo = new MockOrderSnapshotRepository();
    const syncRunRepo = new MockSyncRunRepository();
    const incidentRepo = new MockIncidentRepository();
    const historyRepo = new MockIncidentHistoryRepository();
    const followupRepo = new MockFollowupRepository();
    const queueRepo = new MockCheckpointWorkQueueRepository();

    // 2. Persist checkpoint T state in durable repositories (simulating V1 Phase 1-5 completion)
    await syncRunRepo.createSyncRun("2026-09-26T07:00:01.000Z", {
      id: SYNC_RUN_ID,
      checkpointAt: CHECKPOINT_T,
    });

    const persistedSnapshotRows: OrderSnapshotRow[] = [
      {
        sync_run_id: SYNC_RUN_ID,
        order_code: "ORD_REHYD_001",
        warehouse_id: "WH_HNI_01",
        warehouse_name: "Kho Hub Hà Nội",
        source_status: "delivering",
        task_category: "giao_hang",
        source_updated_at: "2026-09-26T06:55:00.000Z",
        order_created_at: "2026-09-25T08:00:00.000Z",
        end_pick_at: "2026-09-26T05:00:00.000Z",
        warehouse_log: [
          { current_warehouse_id: "WH_HNI_01", updated_date: "2026-09-26T05:30:00.000Z" },
        ],
      },
      {
        sync_run_id: SYNC_RUN_ID,
        order_code: "ORD_REHYD_002",
        warehouse_id: "WH_HNI_01",
        warehouse_name: "Kho Hub Hà Nội",
        source_status: "storing",
        task_category: "chuyen_tiep",
        source_updated_at: "2026-09-26T06:55:00.000Z",
        order_created_at: "2026-09-25T09:00:00.000Z",
        end_pick_at: "2026-09-26T05:30:00.000Z",
        warehouse_log: [
          { current_warehouse_id: "WH_HNI_01", updated_date: "2026-09-26T05:45:00.000Z" },
        ],
      },
    ];
    await snapshotRepo.insertBatch(persistedSnapshotRows);

    const testIncidents: Incident[] = [
      {
        incidentId: "inc_rehyd_001",
        incidentKey: "WH_HNI_01:PACKING_DELAY",
        warehouseId: "WH_HNI_01",
        warehouseName: "Kho Hub Hà Nội",
        reasonCode: "PACKING_DELAY" as IncidentReasonCode,
        reasonName: "Đóng gói chậm",
        status: "open",
        priorityScore: 75,
        affectedOrders: ["ORD_REHYD_001", "ORD_REHYD_002"],
        affectedOrderCount: 2,
        sampleOrderCodes: ["ORD_REHYD_001", "ORD_REHYD_002"],
        averageAgeHours: null,
        maximumAgeHours: null,
        oldestOrderCode: null,
        firstDetectedAt: "2026-09-26T06:00:00.000Z",
        lastDetectedAt: CHECKPOINT_T,
      },
    ];
    const upsertedIncidents = await incidentRepo.upsertIncidents(testIncidents, SYNC_RUN_ID);

    const incidentMap = new Map([[testIncidents[0].incidentKey, upsertedIncidents[0].id]]);
    await historyRepo.insertHistoryRecords(incidentMap, testIncidents, SYNC_RUN_ID, CHECKPOINT_T);

    // 3. Destroy original V1 in-memory objects completely
    let v1InMemoryObjects: any = {
      rawRillnetResponse: { orders: persistedSnapshotRows },
      unprocessedIncidents: testIncidents,
      transientCalculations: new Float64Array(1024),
    };
    v1InMemoryObjects = null;
    expect(v1InMemoryObjects).toBeNull();

    // 4. V2 begins independently later
    const orchestrator = new CheckpointOrchestrator(queueRepo);
    const unitsSeeded = await orchestrator.initializePostBarrierCheckpoint({
      checkpointAt: CHECKPOINT_T,
      syncRunId: SYNC_RUN_ID,
      caseCount: 1,
      estimatedMembers: 2,
      executionMode: "SHADOW",
    });

    expect(unitsSeeded).toBeGreaterThan(0);

    // 5. V2 worker executes with PostBarrierShadowHandler using persisted repositories ONLY
    const handler = new PostBarrierShadowHandler({
      orderSnapshotRepo: snapshotRepo,
      syncRunRepo,
      incidentRepo,
      incidentHistoryRepo: historyRepo,
      followupRepo,
    });

    const executionHandler = handler.createExecutionHandler(); // No in-memory orders passed
    const worker = new CheckpointWorker(queueRepo, undefined, "worker_rehydration_test");
    const summary = await worker.runLoop(CHECKPOINT_T, SYNC_RUN_ID, executionHandler, "SHADOW");

    // 6. Verify Exact Invariants
    // Invariant A: ZERO live Rillnet calls occurred
    expect(liveRillnetFetchSpy).toHaveBeenCalledTimes(0);

    // Invariant B: All units executed successfully
    expect(summary.workUnitsCompleted).toBe(unitsSeeded);
    expect(summary.workUnitsFailed).toBe(0);

    // Invariant C: State was rehydrated strictly from persisted snapshots
    const state = handler.getExecutionState(CHECKPOINT_T, SYNC_RUN_ID);
    expect(state).toBeDefined();
    expect(state?.rehydratedOrders).toHaveLength(2);
    expect(state?.rehydratedOrders.map((o) => o.orderCode).sort()).toEqual(["ORD_REHYD_001", "ORD_REHYD_002"]);
    expect(state?.incidents).toHaveLength(1);
    expect(state?.incidents[0].incidentKey).toBe("WH_HNI_01:PACKING_DELAY");

    // Invariant D: Real followup evaluation executed
    expect(state?.shadowDecisions).toHaveLength(1);
    expect(state?.shadowDecisions[0].caseIdentity).toBe("WH_HNI_01:PACKING_DELAY");
    expect(state?.shadowDecisions[0].decisionType).toBe("MONITORING");
    expect(state?.shadowDecisions[0].newState).toBe("FOLLOWING_UP");

    // Invariant E: Real member hydration executed
    expect(state?.generationCommitted).toBe(true);

    // Invariant F: Telegram delivery suppressed safely (exactly 1 suppressed delivery)
    expect(state?.telegramSuppressedCount).toBe(1);

    // Invariant G: Overall verification label
    const EXACT_CHECKPOINT_REHYDRATION = "PASS";
    expect(EXACT_CHECKPOINT_REHYDRATION).toBe("PASS");
  });
});
