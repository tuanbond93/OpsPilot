import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionQueue, Deduplicator, type EnqueueActionParams } from "@/engine/action-queue";
import { FollowupEngine } from "@/engine/followup";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";
import type { IFollowupRepository } from "@/repositories/interfaces/IFollowupRepository";
import type { FollowupCaseRow, FollowupEventRow } from "@/connectors/supabase/types";
import type { Incident } from "@/engine/incident";
import { SupabaseFollowupRepository } from "@/repositories/supabase/SupabaseFollowupRepository";
import type { SupabaseClient } from "@supabase/supabase-js";

const referenceTimeMs = Date.parse("2026-08-06T00:00:00.000Z");

function makeIncident(index: number, incidentId = "incident-" + index): Incident {
  return {
    incidentId,
    incidentKey: "batch:" + index,
    warehouseId: "warehouse-" + index,
    warehouseName: "Warehouse " + index,
    reasonCode: "KHO_TON",
    reasonName: "Stock backlog",
    status: "open",
    priorityScore: 75,
    firstDetectedAt: "2026-08-05T08:00:00.000Z",
    lastDetectedAt: "2026-08-05T08:00:00.000Z",
    affectedOrderCount: 100,
    sampleOrderCodes: [],
    averageAgeHours: 36,
    maximumAgeHours: 48,
    oldestOrderCode: "ORD-" + index,
  };
}

class CountingFollowupRepository extends MockFollowupRepository {
  caseReadCalls = 0;
  caseBatchCalls = 0;
  eventBatchCalls = 0;
  eventTypes: string[] = [];

  override async getCasesByIncidentKeys(keys: string[]) {
    this.caseReadCalls++;
    return super.getCasesByIncidentKeys(keys);
  }

  override async getAllCases() {
    this.caseReadCalls++;
    return super.getAllCases();
  }

  override async batchUpsertCases(cases: Parameters<IFollowupRepository["batchUpsertCases"]>[0]) {
    this.caseBatchCalls++;
    return super.batchUpsertCases(cases);
  }

  override async batchInsertEvents(events: Parameters<IFollowupRepository["batchInsertEvents"]>[0]) {
    this.eventBatchCalls++;
    this.eventTypes.push(...events.map((event) => event.event_type || ""));
    return super.batchInsertEvents(events);
  }
}

class CountingActionQueue extends ActionQueue {
  enqueueCalls = 0;

  override async enqueueAction(
    params: EnqueueActionParams
  ): ReturnType<ActionQueue["enqueueAction"]> {
    this.enqueueCalls++;
    return super.enqueueAction(params);
  }

  override async enqueueActionBatch(
    paramsList: EnqueueActionParams[]
  ): ReturnType<ActionQueue["enqueueActionBatch"]> {
    this.enqueueCalls += paramsList.length;
    return super.enqueueActionBatch(paramsList);
  }
}

class CaseFailureRepository extends CountingFollowupRepository {
  override async batchUpsertCases(): Promise<FollowupCaseRow[]> {
    this.caseBatchCalls++;
    throw new Error("case batch failed");
  }
}

class EventFailureRepository extends CountingFollowupRepository {
  override async batchInsertEvents(): Promise<FollowupEventRow[]> {
    this.eventBatchCalls++;
    throw new Error("event batch failed");
  }
}

describe("Sprint 10.1 follow-up persistence batching", () => {
  beforeEach(() => {
    Deduplicator.clearMemory();
  });

  it("uses one case batch and one event batch for multiple incidents while preserving event order", async () => {
    const repository = new CountingFollowupRepository();
    const actions = new CountingActionQueue(null);
    const results = await new FollowupEngine(repository, actions).processIncidentFollowups(
      [makeIncident(1), makeIncident(2), makeIncident(3), makeIncident(4), makeIncident(5)],
      new Map(),
      undefined,
      referenceTimeMs
    );

    expect(results.map((result) => result.newState)).toEqual([
      "FIRST_PUSH_PENDING",
      "FIRST_PUSH_PENDING",
      "FIRST_PUSH_PENDING",
      "FIRST_PUSH_PENDING",
      "FIRST_PUSH_PENDING",
    ]);
    expect(repository.caseReadCalls).toBe(2);
    expect(repository.caseBatchCalls).toBe(1);
    expect(repository.eventBatchCalls).toBe(1);
    expect(repository.eventTypes).toEqual(["CASE_CREATED", "CASE_CREATED", "CASE_CREATED", "CASE_CREATED", "CASE_CREATED"]);
    expect(actions.enqueueCalls).toBe(5);
  });

  it("handles multiple incidents with no pending transition actions", async () => {
    const repository = new CountingFollowupRepository();
    const actions = new CountingActionQueue(null);
    const seededCases: FollowupCaseRow[] = [1, 2].map((index) => ({
      id: "case-" + index,
      incident_id: "incident-" + index,
      incident_key: "batch:" + index,
      current_state: "FIRST_PUSH_PENDING",
      first_detected_at: "2026-08-05T08:00:00.000Z",
      last_checked_at: "2026-08-05T08:00:00.000Z",
      baseline_affected_order_count: 100,
      latest_affected_order_count: 100,
      current_progress_percent: 0,
      current_assessment: "no_progress",
      created_at: "2026-08-05T08:00:00.000Z",
      updated_at: "2026-08-05T08:00:00.000Z",
    }));
    repository.seed(seededCases, []);

    const results = await new FollowupEngine(repository, actions).processIncidentFollowups(
      [makeIncident(1), makeIncident(2)],
      new Map(),
      undefined,
      referenceTimeMs
    );

    expect(results.every((result) => result.newState === "FIRST_PUSH_PENDING")).toBe(true);
    expect(actions.enqueueCalls).toBe(0);
    expect(repository.caseBatchCalls).toBe(1);
    expect(repository.eventBatchCalls).toBe(1);
  });

  it("is idempotent for actions on a rerun and keeps one case per incident", async () => {
    const repository = new CountingFollowupRepository();
    const actions = new CountingActionQueue(null);
    const engine = new FollowupEngine(repository, actions);
    const incidents = [makeIncident(1), makeIncident(2)];

    await engine.processIncidentFollowups(incidents, new Map(), undefined, referenceTimeMs);
    await engine.processIncidentFollowups(incidents, new Map(), undefined, referenceTimeMs);

    expect((await repository.getAllCases()).length).toBe(2);
    expect((await actions.getAllActions()).length).toBe(2);
    expect(actions.enqueueCalls).toBe(2);
  });

  it("deduplicates duplicate incident keys in the case batch without duplicating actions", async () => {
    const repository = new CountingFollowupRepository();
    const actions = new CountingActionQueue(null);
    const duplicate = makeIncident(1, "same-incident");

    await new FollowupEngine(repository, actions).processIncidentFollowups(
      [duplicate, { ...duplicate }],
      new Map(),
      undefined,
      referenceTimeMs
    );

    expect(repository.caseBatchCalls).toBe(1);
    expect(repository.eventBatchCalls).toBe(1);
    expect((await repository.getAllCases()).length).toBe(1);
    expect((await repository.getRecentEvents(10)).length).toBe(2);
    expect((await actions.getAllActions()).length).toBe(1);
    expect(actions.enqueueCalls).toBe(2);
  });

  it("does not enqueue actions when the case batch fails", async () => {
    const actions = new CountingActionQueue(null);

    await expect(
      new FollowupEngine(new CaseFailureRepository(), actions).processIncidentFollowups(
        [makeIncident(1), makeIncident(2)],
        new Map(),
        undefined,
        referenceTimeMs
      )
    ).rejects.toThrow("case batch failed");

    expect(actions.enqueueCalls).toBe(0);
  });

  it("does not enqueue actions when the event batch fails after case persistence", async () => {
    const repository = new EventFailureRepository();
    const actions = new CountingActionQueue(null);

    await expect(
      new FollowupEngine(repository, actions).processIncidentFollowups(
        [makeIncident(1), makeIncident(2)],
        new Map(),
        undefined,
        referenceTimeMs
      )
    ).rejects.toThrow("event batch failed");

    expect(repository.caseBatchCalls).toBe(1);
    expect(actions.enqueueCalls).toBe(0);
  });

  it("keeps legacy single-row repository methods working", async () => {
    const repository = new MockFollowupRepository();
    const followupCase = await repository.upsertCase({
      incident_id: "legacy-incident",
      incident_key: "legacy-key",
      current_state: "NEW",
      first_detected_at: "2026-08-05T08:00:00.000Z",
      last_checked_at: "2026-08-05T08:00:00.000Z",
    });
    const event = await repository.insertEvent({
      followup_case_id: followupCase.id,
      event_type: "CASE_CREATED",
      event_time: "2026-08-05T08:00:00.000Z",
      old_state: "NEW",
      new_state: "FIRST_PUSH_PENDING",
      assessment: "no_progress",
    });

    expect(followupCase.id).toBe("fcase-1");
    expect(event.id).toBe("fevt-1");
    expect((await repository.getCasesByIncidentKeys(["legacy-key"])).length).toBe(1);
  });

  it("maps Supabase batch methods with explicit conflict keys and columns", async () => {
    const caseRow: FollowupCaseRow = {
      id: "case-1",
      incident_id: "incident-1",
      incident_key: "batch:1",
      current_state: "FIRST_PUSH_PENDING",
      first_detected_at: "2026-08-05T08:00:00.000Z",
      last_checked_at: "2026-08-06T00:00:00.000Z",
      baseline_affected_order_count: 100,
      latest_affected_order_count: 100,
      current_progress_percent: 0,
      current_assessment: "no_progress",
      created_at: "2026-08-05T08:00:00.000Z",
      updated_at: "2026-08-06T00:00:00.000Z",
    };
    const query = {
      upsert: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      then: (resolve: (value: { data: FollowupCaseRow[]; error: null }) => unknown) =>
        Promise.resolve(resolve({ data: [caseRow], error: null })),
    };
    const client = {
      from: vi.fn().mockReturnValue(query),
    } as unknown as SupabaseClient;
    const repository = new SupabaseFollowupRepository(client);

    const rows = await repository.batchUpsertCases([
      {
        incident_id: "incident-1",
        incident_key: "batch:1",
        current_state: "FIRST_PUSH_PENDING",
      },
    ]);

    expect(rows).toEqual([caseRow]);
    expect(query.upsert).toHaveBeenCalledWith(
      [expect.objectContaining({ incident_id: "incident-1", updated_at: expect.any(String) })],
      { onConflict: "incident_id" }
    );
    expect(query.select).toHaveBeenCalledWith(expect.stringContaining("incident_id"));
    expect(query.select).not.toHaveBeenCalledWith("*");
  });
});
