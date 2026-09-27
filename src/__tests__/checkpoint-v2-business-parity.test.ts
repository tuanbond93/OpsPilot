import { describe, it, expect } from "vitest";
import { FollowupEngine } from "@/engine/followup/followup-engine";
import { DEFAULT_FOLLOWUP_CONFIG } from "@/config/followup";
import { CheckpointOrchestrator } from "@/engine/checkpoint-v2/checkpoint-orchestrator";
import { CheckpointWorker } from "@/engine/checkpoint-v2/checkpoint-worker";
import { PostBarrierShadowHandler } from "@/engine/checkpoint-v2/post-barrier-handler";
import { MockCheckpointWorkQueueRepository } from "@/repositories/mock/MockCheckpointWorkQueueRepository";
import { MockOrderSnapshotRepository } from "@/repositories/mock/MockOrderSnapshotRepository";
import { MockSyncRunRepository } from "@/repositories/mock/MockSyncRunRepository";
import { MockIncidentRepository } from "@/repositories/mock/MockIncidentRepository";
import { MockIncidentHistoryRepository } from "@/repositories/mock/MockIncidentHistoryRepository";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet/types";
import type { Incident, IncidentReasonCode } from "@/engine/incident";
import type { OrderSnapshotRow } from "@/connectors/supabase/types";

describe("Checkpoint Pipeline V2 - Deterministic Business Parity Test (V1 Phase 6 vs V2 Post-Barrier Worker)", () => {
  it("proves 100% parity on case identities, decisions, action types, and member counts between V1 and V2", async () => {
    const CHECKPOINT_14H = "2026-09-26T07:00:00.000Z"; // 14h in UTC+7
    const SYNC_RUN_ID = "run_parity_fixture_001";
    const now = Date.parse(CHECKPOINT_14H);

    // 1. Construct deterministic pre-Phase-6 fixture data
    const orders: NormalizedRillnetOrder[] = [
      {
        id: "ord_p_1",
        orderCode: "ORD_P_001",
        status: "delivering",
        taskCategory: "giao_hang",
        warehouseId: "WH_HNI_01",
        warehouseName: "Kho Hub Hà Nội",
        customerId: "CUST_001",
        customerName: "Khách 1",
        customerCode: "C_1",
        createdAt: "2026-09-25T10:00:00.000Z",
        deliverWarehouseId: "WH_HNI_01",
        warehouseLog: [{ current_warehouse_id: "WH_HNI_01", updated_date: "2026-09-26T05:30:00.000Z" }],
        endPickAt: "2026-09-26T05:00:00.000Z",
        fetchedAt: "2026-09-26T06:55:00.000Z",
      },
      {
        id: "ord_p_2",
        orderCode: "ORD_P_002",
        status: "storing",
        taskCategory: "chuyen_tiep",
        warehouseId: "WH_HNI_01",
        warehouseName: "Kho Hub Hà Nội",
        customerId: "CUST_002",
        customerName: "Khách 2",
        customerCode: "C_2",
        createdAt: "2026-09-25T11:00:00.000Z",
        deliverWarehouseId: "WH_HNI_01",
        warehouseLog: [{ current_warehouse_id: "WH_HNI_01", updated_date: "2026-09-26T05:45:00.000Z" }],
        endPickAt: "2026-09-26T05:30:00.000Z",
        fetchedAt: "2026-09-26T06:55:00.000Z",
      },
      {
        id: "ord_p_3",
        orderCode: "ORD_P_003",
        status: "delivering",
        taskCategory: "giao_hang",
        warehouseId: "WH_SGN_01",
        warehouseName: "Kho Hub Sài Gòn",
        customerId: "CUST_003",
        customerName: "Khách 3",
        customerCode: "C_3",
        createdAt: "2026-09-25T12:00:00.000Z",
        deliverWarehouseId: "WH_SGN_01",
        warehouseLog: [{ current_warehouse_id: "WH_SGN_01", updated_date: "2026-09-26T06:00:00.000Z" }],
        endPickAt: "2026-09-26T05:45:00.000Z",
        fetchedAt: "2026-09-26T06:55:00.000Z",
      },
      {
        id: "ord_p_4",
        orderCode: "ORD_P_004",
        status: "delivering",
        taskCategory: "giao_hang",
        warehouseId: "WH_SGN_01",
        warehouseName: "Kho Hub Sài Gòn",
        customerId: "CUST_004",
        customerName: "Khách 4",
        customerCode: "C_4",
        createdAt: "2026-09-25T12:30:00.000Z",
        deliverWarehouseId: "WH_SGN_01",
        warehouseLog: [{ current_warehouse_id: "WH_SGN_01", updated_date: "2026-09-26T06:15:00.000Z" }],
        endPickAt: "2026-09-26T06:00:00.000Z",
        fetchedAt: "2026-09-26T06:55:00.000Z",
      },
      {
        id: "ord_p_5",
        orderCode: "ORD_P_005",
        status: "storing",
        taskCategory: "chuyen_tiep",
        warehouseId: "WH_SGN_01",
        warehouseName: "Kho Hub Sài Gòn",
        customerId: "CUST_005",
        customerName: "Khách 5",
        customerCode: "C_5",
        createdAt: "2026-09-25T13:00:00.000Z",
        deliverWarehouseId: "WH_SGN_01",
        warehouseLog: [{ current_warehouse_id: "WH_SGN_01", updated_date: "2026-09-26T06:20:00.000Z" }],
        endPickAt: "2026-09-26T06:10:00.000Z",
        fetchedAt: "2026-09-26T06:55:00.000Z",
      },
    ];

    const incidents: Incident[] = [
      {
        incidentId: "inc_case_1",
        incidentKey: "WH_HNI_01:PACKING_DELAY",
        warehouseId: "WH_HNI_01",
        warehouseName: "Kho Hub Hà Nội",
        reasonCode: "PACKING_DELAY" as IncidentReasonCode,
        reasonName: "Đóng gói chậm",
        status: "open",
        priorityScore: 80,
        affectedOrders: ["ORD_P_001", "ORD_P_002"],
        affectedOrderCount: 2,
        sampleOrderCodes: ["ORD_P_001", "ORD_P_002"],
        averageAgeHours: null,
        maximumAgeHours: null,
        oldestOrderCode: null,
        firstDetectedAt: "2026-09-26T06:00:00.000Z",
        lastDetectedAt: CHECKPOINT_14H,
      },
      {
        incidentId: "inc_case_2",
        incidentKey: "WH_SGN_01:TRANSIT_DELAY",
        warehouseId: "WH_SGN_01",
        warehouseName: "Kho Hub Sài Gòn",
        reasonCode: "TRANSIT_DELAY" as IncidentReasonCode,
        reasonName: "Chuyển tiếp chậm",
        status: "open",
        priorityScore: 60,
        affectedOrders: ["ORD_P_003", "ORD_P_004", "ORD_P_005"],
        affectedOrderCount: 3,
        sampleOrderCodes: ["ORD_P_003", "ORD_P_004", "ORD_P_005"],
        averageAgeHours: null,
        maximumAgeHours: null,
        oldestOrderCode: null,
        firstDetectedAt: "2026-09-26T06:00:00.000Z",
        lastDetectedAt: CHECKPOINT_14H,
      },
    ];

    // 2. Persist into durable repositories (pre-barrier state)
    const snapshotRepo = new MockOrderSnapshotRepository();
    const syncRunRepo = new MockSyncRunRepository();
    const incidentRepo = new MockIncidentRepository();
    const historyRepo = new MockIncidentHistoryRepository();

    await syncRunRepo.createSyncRun("2026-09-26T07:00:01.000Z", {
      id: SYNC_RUN_ID,
      checkpointAt: CHECKPOINT_14H,
    });

    const snapshotRows: OrderSnapshotRow[] = orders.map((o) => ({
      sync_run_id: SYNC_RUN_ID,
      order_code: o.orderCode,
      warehouse_id: o.warehouseId,
      warehouse_name: o.warehouseName,
      customer_id: o.customerId,
      source_status: o.status,
      task_category: o.taskCategory,
      source_updated_at: o.fetchedAt,
      order_created_at: o.createdAt,
      end_pick_at: o.endPickAt,
      warehouse_log: o.warehouseLog,
    }));
    await snapshotRepo.insertBatch(snapshotRows);

    const upsertedIncidents = await incidentRepo.upsertIncidents(incidents, SYNC_RUN_ID);
    const incidentMap = new Map(incidents.map((inc, i) => [inc.incidentKey, upsertedIncidents[i].id]));
    await historyRepo.insertHistoryRecords(incidentMap, incidents, SYNC_RUN_ID, CHECKPOINT_14H);

    const historyMap = await historyRepo.getHistoriesByIncidentIds(
      upsertedIncidents.map((i) => i.id)
    );

    // ========================================================================
    // 3. EXECUTE V1 PHASE 6
    // ========================================================================
    const v1FollowupRepo = new MockFollowupRepository();
    const v1Engine = new FollowupEngine(v1FollowupRepo);
    const v1Results = await v1Engine.processIncidentFollowups(
      incidents,
      historyMap,
      DEFAULT_FOLLOWUP_CONFIG,
      now,
      orders,
      SYNC_RUN_ID
    );

    // ========================================================================
    // 4. EXECUTE V2 POST-BARRIER WORKER (INDEPENDENT)
    // ========================================================================
    const queueRepo = new MockCheckpointWorkQueueRepository();
    const orchestrator = new CheckpointOrchestrator(queueRepo);
    await orchestrator.initializePostBarrierCheckpoint({
      checkpointAt: CHECKPOINT_14H,
      syncRunId: SYNC_RUN_ID,
      caseCount: incidents.length,
      estimatedMembers: orders.length,
      executionMode: "SHADOW",
    });

    const v2FollowupRepo = new MockFollowupRepository();
    const v2Handler = new PostBarrierShadowHandler({
      orderSnapshotRepo: snapshotRepo,
      syncRunRepo,
      incidentRepo,
      incidentHistoryRepo: historyRepo,
      followupRepo: v2FollowupRepo,
    });

    const worker = new CheckpointWorker(queueRepo, undefined, "v2_parity_worker");
    await worker.runLoop(CHECKPOINT_14H, SYNC_RUN_ID, v2Handler.createExecutionHandler(), "SHADOW");

    const v2Decisions = v2Handler.getShadowDecisions(CHECKPOINT_14H, SYNC_RUN_ID);
    const v2State = v2Handler.getExecutionState(CHECKPOINT_14H, SYNC_RUN_ID);

    // ========================================================================
    // 5. COMPARE V1 VS V2 ON BUSINESS METRICS
    // ========================================================================
    const v1CaseKeys = v1Results.map((r) => r.incidentKey).sort();
    const v2CaseKeys = v2Decisions.map((d) => d.caseIdentity).sort();

    // Metric 1: Case Identities
    expect(v2CaseKeys).toEqual(v1CaseKeys);
    const casesMatch = v1CaseKeys.length === v2CaseKeys.length;

    // Metric 2: Decisions (State Transitions)
    const v1DecisionsMap = new Map(v1Results.map((r) => [r.incidentKey, r.newState]));
    const v2DecisionsMap = new Map(v2Decisions.map((d) => [d.caseIdentity, d.newState]));

    let decisionsMatchCount = 0;
    const unexplainedMismatches: string[] = [];

    for (const key of v1CaseKeys) {
      const v1State = v1DecisionsMap.get(key);
      const v2StateValue = v2DecisionsMap.get(key);
      if (v1State === v2StateValue) {
        decisionsMatchCount++;
      } else {
        unexplainedMismatches.push(`Decision mismatch for ${key}: V1=${v1State}, V2=${v2StateValue}`);
      }
    }

    // Metric 3: Action / Intervention Types
    for (const r of v1Results) {
      const v2Dec = v2Decisions.find((d) => d.caseIdentity === r.incidentKey);
      const v1ActionType = r.newState === "FIRST_PUSH_PENDING" ? "FIRST_PUSH" : null;
      if (v1ActionType) {
        expect(v2Dec?.actionType).toBe(v1ActionType);
      }
    }

    // Metric 4: Member Counts & Generation Commitment
    const v1Cases = await v1FollowupRepo.getAllCases();
    const v1TotalMembers = v1Cases.reduce(
      (sum, c) => sum + (c.operational_cohort?.members?.length || 0),
      0
    );
    const v2TotalMembers = v2Decisions.reduce((sum, d) => sum + d.memberCount, 0);
    expect(v2TotalMembers).toBe(v1TotalMembers);
    expect(v2State?.generationCommitted).toBe(true);

    // Metric 5: only governed action decisions reserve a SHADOW dispatch.
    expect(v2State?.telegramSuppressedCount).toBe(
      v2Decisions.filter((decision) => decision.actionType !== null).length
    );

    // Final Parity Assertions
    expect(casesMatch).toBe(true);
    expect(decisionsMatchCount).toBe(v1CaseKeys.length);
    expect(unexplainedMismatches).toHaveLength(0);

    // Output raw evidence metrics
    console.log(`BUSINESS_PARITY_CASES: ${v2CaseKeys.length}/${v1CaseKeys.length} PASS`);
    console.log(`BUSINESS_PARITY_DECISIONS: ${decisionsMatchCount}/${v1CaseKeys.length} PASS`);
    console.log(`BUSINESS_PARITY_MEMBERS: ${v2TotalMembers}/${v1TotalMembers} PASS`);
    console.log(`UNEXPLAINED_BUSINESS_MISMATCHES: ${unexplainedMismatches.length}`);
  });
});
