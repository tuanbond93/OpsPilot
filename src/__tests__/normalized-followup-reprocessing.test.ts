import { describe, expect, it } from "vitest";
import type { OperationalCohort } from "@/domain/operational-learning/checkpoint-policy";
import { FollowupEngine } from "@/engine/followup";
import type { Incident } from "@/engine/incident";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const INCIDENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const ORDER_CODE = "ORDER-CURRENT";
const CHECKPOINT = Date.parse("2026-09-24T01:00:00.000Z");
const INCIDENT_KEY = "warehouse-a:KHO_TON";

function cohort(failures: Record<string, string>): OperationalCohort {
  return {
    version: 1,
    day: "2026-09-24",
    capturedAt: "2026-09-24T01:00:00.000Z",
    baselineCodes: [ORDER_CODE],
    lastCheckpoint: "2026-09-24:8",
    members: [{
      orderCode: ORDER_CODE,
      customerId: "customer-a",
      warehouseId: "warehouse-a",
      stage: "TRANSIT",
      status: "storing",
      observedAt: "2026-09-24T01:00:00.000Z",
      readyAt: null,
      source: "rillnet",
      baselineStatus: "storing",
      dueAt: "2026-09-24T00:00:00.000Z",
    }],
    verification: {
      source: "ghn_internal_order_logs",
      checkedAt: "2026-09-24T01:00:00.000Z",
      snapshotAt: "2026-09-24T01:00:00.000Z",
      failures,
    },
  };
}

function incident(): Incident {
  return {
    incidentId: INCIDENT_ID,
    incidentKey: INCIDENT_KEY,
    warehouseId: "warehouse-a",
    warehouseName: "Warehouse A",
    reasonCode: "KHO_TON",
    reasonName: "Stock backlog",
    status: "monitoring",
    priorityScore: 75,
    firstDetectedAt: "2026-09-20T01:00:00.000Z",
    lastDetectedAt: "2026-09-24T01:00:00.000Z",
    affectedOrderCount: 1,
    affectedOrders: [ORDER_CODE],
    sampleOrderCodes: [ORDER_CODE],
    averageAgeHours: 24,
    maximumAgeHours: 24,
    oldestOrderCode: ORDER_CODE,
  };
}

function order(): NormalizedRillnetOrder {
  return {
    id: ORDER_CODE,
    orderCode: ORDER_CODE,
    status: "storing",
    taskCategory: "Kho tồn",
    warehouseId: "warehouse-a",
    warehouseName: "Warehouse A",
    customerId: "customer-a",
    customerName: "Customer A",
    customerCode: "customer-a",
    createdAt: "2026-09-23T23:00:00.000Z",
    deliverWarehouseId: "destination",
    fetchedAt: "2026-09-24T01:00:00.000Z",
    warehouseLog: [],
  };
}

async function v2Repository(failures: Record<string, string>) {
  const repository = new MockFollowupRepository();
  const source = cohort(failures);
  repository.seed([{
    id: CASE_ID,
    incident_id: INCIDENT_ID,
    incident_key: INCIDENT_KEY,
    current_state: "FOLLOWING_UP",
    first_detected_at: "2026-09-20T01:00:00.000Z",
    last_checked_at: "2026-09-24T01:00:00.000Z",
    baseline_affected_order_count: 1,
    latest_affected_order_count: 1,
    current_progress_percent: 0,
    current_assessment: "no_progress",
    operational_cohort: source,
  } as any], []);
  await repository.persistOperationalCohortGenerations([{
    id: CASE_ID,
    incident_id: INCIDENT_ID,
    incident_key: INCIDENT_KEY,
    current_state: "FOLLOWING_UP",
    first_detected_at: "2026-09-20T01:00:00.000Z",
    last_checked_at: "2026-09-24T01:00:00.000Z",
    baseline_affected_order_count: 1,
    latest_affected_order_count: 1,
    current_progress_percent: 0,
    current_assessment: "no_progress",
    operational_cohort: source,
  } as any], RUN_ID);
  return repository;
}

describe("normalized cohort verification failure checkpoint behavior", () => {
  it("does not reprocess same-checkpoint V2 cohorts with orphan-only failures", async () => {
    const repository = await v2Repository({ "PRUNED-ORDER": "BUDGET_DEFERRED" });
    const hydrated = await repository.getCaseById(CASE_ID);
    expect(hydrated?.operational_cohort?.verification?.failures).toEqual({});

    const engine = new FollowupEngine(repository);
    const results = await engine.processIncidentFollowups([incident()], new Map(), undefined, CHECKPOINT, [order()]);

    expect(results).toEqual([]);
    expect(engine.getLastRunMetrics()?.caseWrites).toBe(0);
  });

  it("continues same-checkpoint V2 reprocessing when a current member has a verification failure", async () => {
    const repository = await v2Repository({ [ORDER_CODE]: "TRACKING_UNAVAILABLE" });
    const hydrated = await repository.getCaseById(CASE_ID);
    expect(hydrated?.operational_cohort?.verification?.failures).toEqual({ [ORDER_CODE]: "TRACKING_UNAVAILABLE" });

    const engine = new FollowupEngine(repository);
    const results = await engine.processIncidentFollowups([incident()], new Map(), undefined, CHECKPOINT, [order()]);

    expect(results).toHaveLength(1);
    expect(engine.getLastRunMetrics()?.caseWrites).toBeGreaterThan(0);
  });
});
