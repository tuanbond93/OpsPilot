import { describe, expect, it, vi } from "vitest";
import type { FollowupCaseRow } from "@/connectors/supabase/types";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet";
import type { OperationalCohort } from "@/domain/operational-learning/checkpoint-policy";
import { FollowupEngine } from "@/engine/followup/followup-engine";
import type { Incident } from "@/engine/incident";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";

const CASE_ID = "46f2fbcc-7708-4703-bd58-9bac8a0be8d6";
const INCIDENT_ID = "37c8144d-df8c-495e-82a4-2a5de53cb5e9";
const REFRESHED_INCIDENT_ID = "57c8144d-df8c-495e-82a4-2a5de53cb5e9";
const INCIDENT_KEY = "21454000:THIEU_SHIPPER";
const ORDER_CODE = "ORDER-CLOSED-CASE-REUSE";
const FIRST_RUN_ID = "22222222-2222-4222-8222-222222222222";
const RESUME_RUN_ID = "33333333-3333-4333-8333-333333333333";
const CHECKPOINT_18H = Date.parse("2026-09-25T11:00:00.000Z");
const CHECKPOINT_20H = Date.parse("2026-09-25T13:00:00.000Z");

function cohort(lastCheckpoint = "2026-09-25:14"): OperationalCohort {
  return {
    version: 1,
    day: "2026-09-25",
    capturedAt: "2026-09-25T09:00:00.000Z",
    baselineCodes: [ORDER_CODE],
    lastCheckpoint,
    members: [{
      orderCode: ORDER_CODE,
      customerId: "customer-test",
      warehouseId: "warehouse-test",
      stage: "TRANSIT",
      status: "storing",
      observedAt: "2026-09-25T09:00:00.000Z",
      readyAt: null,
      source: "rillnet",
      baselineStatus: "storing",
      dueAt: "2026-09-25T08:00:00.000Z",
    }],
  };
}

function closedCase(sourceIncidentId = INCIDENT_ID): FollowupCaseRow {
  return {
    id: CASE_ID,
    incident_id: sourceIncidentId,
    incident_key: INCIDENT_KEY,
    current_state: "CLOSED",
    first_detected_at: "2026-09-20T01:00:00.000Z",
    last_checked_at: "2026-09-24T01:00:00.000Z",
    last_action_requested_at: null,
    last_action_confirmed_at: null,
    resolved_at: "2026-09-24T01:00:00.000Z",
    baseline_affected_order_count: 1,
    latest_affected_order_count: 0,
    current_progress_percent: 100,
    current_assessment: "no_progress",
    current_rillnet_status_signature: "",
    updated_at: "2026-09-24T01:00:00.000Z",
    operational_cohort: cohort(),
    cohort_version: 1,
    member_generation_id: null,
  };
}

function incident(incidentId = INCIDENT_ID): Incident {
  return {
    incidentId,
    incidentKey: INCIDENT_KEY,
    warehouseId: "warehouse-test",
    warehouseName: "Test warehouse",
    reasonCode: "KHO_TON",
    reasonName: "Stock backlog",
    status: "monitoring",
    priorityScore: 50,
    firstDetectedAt: "2026-09-25T10:00:00.000Z",
    lastDetectedAt: "2026-09-25T10:00:00.000Z",
    affectedOrderCount: 1,
    affectedOrders: [ORDER_CODE],
    sampleOrderCodes: [ORDER_CODE],
    averageAgeHours: 24,
    maximumAgeHours: 24,
    oldestOrderCode: ORDER_CODE,
  };
}

function order(fetchedAt: string): NormalizedRillnetOrder {
  return {
    id: ORDER_CODE,
    orderCode: ORDER_CODE,
    status: "storing",
    taskCategory: "Kho tồn",
    warehouseId: "warehouse-test",
    warehouseName: "Test warehouse",
    customerId: "customer-test",
    customerName: "Test customer",
    customerCode: "customer-test",
    createdAt: "2026-09-24T08:00:00.000Z",
    deliverWarehouseId: "destination-test",
    fetchedAt,
    warehouseLog: [],
  };
}

describe("closed follow-up case stable-key reuse", () => {
  it("finds a CLOSED V1 case omitted by the active-case page and preserves its parent id", async () => {
    const repository = new MockFollowupRepository();
    repository.seed([closedCase()], []);
    const lookup = vi.spyOn(repository, "getCasesByIncidentKeys");

    const result = await new FollowupEngine(repository).processIncidentFollowups(
      [incident()], new Map(), undefined, CHECKPOINT_18H,
      [order("2026-09-25T10:58:00.000Z")], RESUME_RUN_ID,
    );

    expect(lookup).toHaveBeenCalledWith([INCIDENT_KEY]);
    expect(result).toHaveLength(1);
    const rows = await repository.getAllCases();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: CASE_ID, incident_key: INCIDENT_KEY });
  });

  it("keeps the stable parent when the source incident id is refreshed", async () => {
    const repository = new MockFollowupRepository();
    repository.seed([closedCase()], []);

    await new FollowupEngine(repository).processIncidentFollowups(
      [incident(REFRESHED_INCIDENT_ID)], new Map(), undefined, CHECKPOINT_18H,
      [order("2026-09-25T10:58:00.000Z")], RESUME_RUN_ID,
    );

    const rows = await repository.getAllCases();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: CASE_ID, incident_id: REFRESHED_INCIDENT_ID, incident_key: INCIDENT_KEY });
  });

  it("hydrates an existing V2 CLOSED case and persists the state-machine result on the same parent", async () => {
    const repository = new MockFollowupRepository();
    repository.seed([closedCase()], []);
    await repository.persistOperationalCohortGenerations([{
      ...closedCase(),
      operational_cohort: cohort("2026-09-25:18"),
    }], FIRST_RUN_ID);

    const result = await new FollowupEngine(repository).processIncidentFollowups(
      [incident()], new Map(), undefined, CHECKPOINT_20H,
      [order("2026-09-25T12:58:00.000Z")], RESUME_RUN_ID,
    );

    expect(result).toHaveLength(1);
    const rows = await repository.getAllCases();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: CASE_ID, incident_key: INCIDENT_KEY, cohort_version: 2, member_generation_id: RESUME_RUN_ID });
    expect(rows[0].current_state).toBe(result[0].newState);
  });
});
