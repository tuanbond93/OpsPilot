import { describe, expect, it } from "vitest";
import { FollowupEngine } from "@/engine/followup";
import { ActionQueue } from "@/engine/action-queue";
import type { FollowupCaseRow } from "@/connectors/supabase/types";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet";
import type { Incident } from "@/engine/incident";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";

const CHECKPOINT = Date.parse("2026-09-24T01:00:00.000Z");
const PREVIOUS_DAY = "2026-09-23";

class CountingFollowupRepository extends MockFollowupRepository {
  readonly bulkEventReads: number[] = [];
  singleEventReads = 0;

  override async getEventsByCaseId(caseId: string) {
    this.singleEventReads++;
    return super.getEventsByCaseId(caseId);
  }

  override async getEventsByCaseIds(caseIds: string[]) {
    this.bulkEventReads.push(caseIds.length);
    return super.getEventsByCaseIds(caseIds);
  }
}

class CountingActionQueue extends ActionQueue {
  readonly bulkIncidentReads: number[] = [];
  singleIncidentReads = 0;

  override async getActionsByIncidentId(incidentId: string) {
    this.singleIncidentReads++;
    return super.getActionsByIncidentId(incidentId);
  }

  override async getActionsByIncidentIds(incidentIds: string[]) {
    this.bulkIncidentReads.push(incidentIds.length);
    return super.getActionsByIncidentIds(incidentIds);
  }
}

function makeIncident(index: number): Incident {
  const orderCode = `ORDER-${index}`;
  return {
    incidentId: `incident-${index}`,
    incidentKey: `warehouse-${index}:KHO_TON`,
    warehouseId: `warehouse-${index}`,
    warehouseName: `Kho trung chuyển ${index}`,
    reasonCode: "KHO_TON",
    reasonName: "Stock backlog",
    status: "monitoring",
    priorityScore: 75,
    firstDetectedAt: "2026-09-20T01:00:00.000Z",
    lastDetectedAt: "2026-09-24T01:00:00.000Z",
    affectedOrderCount: 1,
    affectedOrders: [orderCode],
    sampleOrderCodes: [orderCode],
    averageAgeHours: 24,
    maximumAgeHours: 24,
    oldestOrderCode: orderCode,
  };
}

function makeOrder(index: number): NormalizedRillnetOrder {
  const warehouseId = `warehouse-${index}`;
  const orderCode = `ORDER-${index}`;
  return {
    id: orderCode,
    orderCode,
    status: "storing",
    taskCategory: "Kho tồn",
    warehouseId,
    warehouseName: `Kho trung chuyển ${index}`,
    customerId: `customer-${index}`,
    customerName: `Customer ${index}`,
    customerCode: `customer-${index}`,
    createdAt: "2026-09-23T23:00:00.000Z",
    deliverWarehouseId: "destination",
    fetchedAt: "2026-09-24T01:00:00.000Z",
    warehouseLog: [{ current_warehouse_id: warehouseId, updated_date: { $date: "2026-09-23T23:00:00.000Z" } }],
  };
}

function makeLegacyCase(index: number): FollowupCaseRow {
  const orderCode = `ORDER-${index}`;
  const warehouseId = `warehouse-${index}`;
  return {
    id: `case-${index}`,
    incident_id: `incident-${index}`,
    incident_key: `${warehouseId}:KHO_TON`,
    current_state: "FOLLOWING_UP",
    first_detected_at: "2026-09-20T01:00:00.000Z",
    last_checked_at: "2026-09-23T11:00:00.000Z",
    baseline_affected_order_count: 1,
    latest_affected_order_count: 1,
    current_progress_percent: 0,
    current_assessment: "no_progress",
    current_rillnet_status_signature: "",
    updated_at: "2026-09-23T11:00:00.000Z",
    operational_cohort: {
      version: 1,
      day: PREVIOUS_DAY,
      capturedAt: "2026-09-23T01:00:00.000Z",
      baselineCodes: [orderCode],
      lastCheckpoint: `${PREVIOUS_DAY}:18`,
      members: [{
        orderCode,
        customerId: `customer-${index}`,
        warehouseId,
        stage: "TRANSIT",
        status: "storing",
        observedAt: "2026-09-23T01:00:00.000Z",
        readyAt: "2026-09-23T00:00:00.000Z",
        source: "rillnet",
        firstSeenAt: "2026-09-23T01:00:00.000Z",
        dueAt: "2026-09-23T00:00:00.000Z",
        baselineStatus: "storing",
      }],
    },
  };
}

describe("legacy follow-up history reads", () => {
  it("uses bounded bulk event/action reads and preserves clean legacy recovery decisions", async () => {
    const count = 540;
    const repository = new CountingFollowupRepository();
    repository.seed(Array.from({ length: count }, (_, index) => makeLegacyCase(index)), []);
    const actionQueue = new CountingActionQueue(null);
    const incidents = Array.from({ length: count }, (_, index) => makeIncident(index));
    const orders = Array.from({ length: count }, (_, index) => makeOrder(index));

    const results = await new FollowupEngine(repository, actionQueue).processIncidentFollowups(
      incidents,
      new Map(),
      undefined,
      CHECKPOINT,
      orders
    );

    expect(results).toHaveLength(count);
    expect(results.every(result => result.newState === "FIRST_PUSH_PENDING")).toBe(true);
    expect(repository.bulkEventReads).toEqual([100, 100, 100, 100, 100, 40]);
    expect(actionQueue.bulkIncidentReads).toEqual([100, 100, 100, 100, 100, 40]);
    expect(repository.singleEventReads).toBe(0);
    expect(actionQueue.singleIncidentReads).toBe(0);
    expect(await actionQueue.getAllActions()).toHaveLength(count);
  });
});
