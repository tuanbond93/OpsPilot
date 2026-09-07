import { describe, expect, it, vi } from "vitest";
import { assessOperationalCohort, nextCot, checkpointKey, type OrderEvidence, type OperationalCohort } from "@/domain/operational-learning/checkpoint-policy";
import { verifyOutcomeObservation } from "@/domain/decision/outcome-verifier";
import { FollowupEngine } from "@/engine/followup/followup-engine";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";
import { aggregateIncidents } from "@/engine/incident";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet";
import { ActionQueue, Deduplicator } from "@/engine/action-queue";

const time = (hour: number, day = "2026-09-05") => `${day}T${String(hour).padStart(2, "0")}:00:00+07:00`;
const evidence = (code: string, status = "storing", stage: OrderEvidence["stage"] = "DELIVERY", hour = 8): OrderEvidence => ({
  orderCode: code, customerId: "customer", warehouseId: "warehouse", stage, status, observedAt: time(hour), readyAt: time(6),
});
function assess(previous: OperationalCohort | null, incoming: OrderEvidence[], current: OrderEvidence[], hour: number, day?: string) {
  return assessOperationalCohort(previous, incoming, new Map(current.map(order => [order.orderCode, order])), Date.parse(time(hour, day)));
}

describe("approved operational checkpoints", () => {
  it("uses fresh Rillnet at routine checkpoints even when legacy GHN-required flag is set", async () => {
    vi.stubEnv("GHN_CHECKPOINT_EVIDENCE", "required");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(time(8)));
    try {
      const repo = new MockFollowupRepository();
      const engine = new FollowupEngine(repo);
      const order: NormalizedRillnetOrder = { id: "GHN1", orderCode: "GHN1", status: "storing", taskCategory: "", warehouseId: "20121005", warehouseName: "(LCH) Nậm Mạ", customerId: "C", customerName: "C", customerCode: "C", createdAt: time(6), deliverWarehouseId: "20121005", fetchedAt: time(8) };
      await engine.processIncidentFollowups(aggregateIncidents([order]), undefined, undefined, Date.now(), [order]);
      clock.mockReturnValue(Date.parse(time(10)));
      await engine.processIncidentFollowups([], undefined, undefined, Date.now(), [{ ...order, status: "delivering", fetchedAt: time(10) }]);
      expect((await repo.getAllCases())[0]).toMatchObject({ current_state: "FOLLOWING_UP", current_progress_percent: 100 });
      clock.mockReturnValue(Date.parse(time(20)));
      await engine.processIncidentFollowups([], undefined, undefined, Date.now(), [{ ...order, fetchedAt: time(20) }]);
      const saved = (await repo.getAllCases())[0];
      expect(saved.current_state).toBe("FIRST_PUSH_PENDING");
      expect(saved.operational_cohort?.members[0].source).toBe("rillnet");
    } finally {
      clock.mockRestore(); vi.unstubAllEnvs();
    }
  });
  it("keeps a later checkpoint reminder distinct from an earlier pending push", async () => {
    Deduplicator.clearMemory();
    const repo = new MockFollowupRepository();
    const queue = new ActionQueue(null);
    const engine = new FollowupEngine(repo, queue);
    const order: NormalizedRillnetOrder = { id: "checkpoint-A", orderCode: "checkpoint-A", status: "storing", taskCategory: "", warehouseId: "W", warehouseName: "Kho GHN", customerId: "C", customerName: "C", customerCode: "C", createdAt: time(6), deliverWarehouseId: "W", fetchedAt: time(8) };
    for (const hour of [8, 10, 20]) {
      const current = { ...order, fetchedAt: time(hour) };
      await engine.processIncidentFollowups(aggregateIncidents([current]), undefined, undefined, Date.parse(time(hour)), [current]);
    }
    const actions = await queue.getAllActions();
    expect(actions).toHaveLength(2);
    expect(new Set(actions.map(action => action.deduplication_key)).size).toBe(2);
    expect(actions.map(action => action.payload.operationalCheckpoint).sort()).toEqual(["2026-09-05:10", "2026-09-05:20"]);
  });
  it("uses 8/10/14/18/20 local hours and waits for the next COT after departure", () => {
    expect(checkpointKey(Date.parse(time(12)))).toBeNull();
    expect(checkpointKey(Date.parse(time(20)))).toBe("2026-09-05:20");
    expect(nextCot(time(6), 7)).toBe(Date.parse(time(7)));
    expect(nextCot(time(7), 7)).toBe(Date.parse(time(7, "2026-09-06")));
    expect(nextCot(time(19), 18)).toBe(Date.parse(time(18, "2026-09-06")));
  });
  it("saves a silent morning baseline and counts storing → delivering as progress", () => {
    const orders = [evidence("A"), evidence("B")];
    const baseline = assess(null, orders, orders, 8);
    expect(baseline.reminderCodes).toEqual([]);
    expect(baseline.assessment).toBe("insufficient_data");
    const progress = assess(baseline.cohort, [], orders.map(order => ({ ...order, status: "delivering", observedAt: time(10) })), 10);
    expect(progress).toMatchObject({ progressed: 2, completed: 0, progressPercent: 100, reminderCodes: [] });
    for (const hour of [14, 18]) expect(assess(progress.cohort, [], orders.map(order => ({ ...order, status: "delivering", observedAt: time(hour) })), hour).reminderCodes).toEqual([]);
    expect(assess(progress.cohort, [], orders.map(order => ({ ...order, status: "delivering", observedAt: time(20) })), 20).reminderCodes).toEqual(["A", "B"]);
  });

  it("persists the 08h baseline when the source fetchedAt is slightly stale", async () => {
    vi.stubEnv("GHN_CHECKPOINT_EVIDENCE", "disabled");
    const repo = new MockFollowupRepository();
    const engine = new FollowupEngine(repo);
    const order: NormalizedRillnetOrder = {
      id: "baseline-stale-source", orderCode: "baseline-stale-source", status: "storing",
      taskCategory: "", warehouseId: "W", warehouseName: "Kho GHN", customerId: "C",
      customerName: "C", customerCode: "C", createdAt: time(6), deliverWarehouseId: "W",
      fetchedAt: time(7),
    };

    try {
      await engine.processIncidentFollowups(aggregateIncidents([order]), undefined, undefined, Date.parse(time(8)), [order]);
      expect((await repo.getAllCases())[0].operational_cohort?.baselineCodes).toEqual(["baseline-stale-source"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("recognizes all 16 transit orders exported even if total stock grows", () => {
    const old = Array.from({ length: 16 }, (_, i) => evidence(`OLD${i}`, "storing", "TRANSIT"));
    const baseline = assess(null, old, old, 8);
    const fresh = { ...evidence("NEW", "storing", "TRANSIT", 10), readyAt: time(9) };
    const result = assess(baseline.cohort, [fresh], [...old.map(order => ({ ...order, status: "transporting", observedAt: time(10) })), fresh], 10);
    expect(result).toMatchObject({ due: 16, completed: 16, progressed: 16, waiting: 1, newOrders: 1, reminderCodes: [] });
  });
  it("does not treat missing or stale order evidence as success", () => {
    const order = evidence("A");
    const baseline = assess(null, [order], [order], 8);
    for (const observations of [[], [order]]) expect(assess(baseline.cohort, [], observations, 10)).toMatchObject({ completed: 0, unknown: 1, assessment: "insufficient_data", reminderCodes: [] });
  });
  it("keeps old deadlines overnight and tracks newly picked work due at 18h", () => {
    const old = evidence("OLD");
    const baseline = assess(null, [old], [old], 8);
    const nextDay = assess(baseline.cohort, [], [{ ...old, observedAt: time(10, "2026-09-06") }], 10, "2026-09-06");
    expect(nextDay.cohort.members[0].dueAt).toBe(new Date(time(10)).toISOString());
    expect(nextDay.reminderCodes).toEqual(["OLD"]);
    const newOrder = { ...evidence("NEW", "storing", "OUTBOUND", 14), readyAt: time(11) };
    const afternoon = assess(baseline.cohort, [newOrder], [newOrder], 14);
    expect(afternoon.waiting).toBe(1);
    expect(assess(afternoon.cohort, [], [{ ...newOrder, observedAt: time(18) }], 18).reminderCodes).toEqual(["NEW"]);
  });
  it("does not repeat unchanged reminders, but reacts to a failed delivery", () => {
    const member = { ...evidence("A"), firstSeenAt: time(8), dueAt: time(10), baselineStatus: "storing", lastReminderAt: time(10), lastReminderStatus: "storing" };
    const cohort: OperationalCohort = { version: 1, day: "2026-09-05", capturedAt: time(8), baselineCodes: ["A"], members: [member] };
    expect(assess(cohort, [], [evidence("A", "storing", "DELIVERY", 14)], 14).reminderCodes).toEqual([]);
    expect(assess(cohort, [], [evidence("A", "delivery_fail", "DELIVERY", 14)], 14).reminderCodes).toEqual(["A"]);
  });
  it("abstains from count-only outcome verification and verifies an explicit cohort", () => {
    const orders = [evidence("A", "storing", "TRANSIT")];
    const cohort = assess(null, orders, orders, 8).cohort;
    const contract = { measurementWindowEnd: time(10), baselineSnapshot: { operationalFacts: { affectedOrders: 1, operationalCohort: cohort } } } as any;
    const input = { observedAt: time(10), observedMetrics: { affectedOrders: 100 }, evidenceRefs: ["snapshot"], decisionId: "D", source: "test", actor: "test" } as any;
    expect(verifyOutcomeObservation(contract, input).classification).toBe("INCONCLUSIVE");
    input.observedMetrics.orders = [evidence("A", "transporting", "TRANSIT", 10), evidence("NEW", "storing", "TRANSIT", 10)];
    expect(verifyOutcomeObservation(contract, input).classification).toBe("SUCCESS");
  });
  it("persists the cohort through sync and checks disappeared incidents by order evidence", async () => {
    const repo = new MockFollowupRepository();
    const engine = new FollowupEngine(repo);
    const order: NormalizedRillnetOrder = { id: "A", orderCode: "A", status: "storing", taskCategory: "", warehouseId: "W", warehouseName: "Kho GHN", customerId: "C", customerName: "C", customerCode: "C", createdAt: time(6), deliverWarehouseId: "W", fetchedAt: time(8), warehouseLog: [{ current_warehouse_id: "W", updated_date: { $date: time(6) } }] };
    await engine.processIncidentFollowups(aggregateIncidents([order]), undefined, undefined, Date.parse(time(8)), [order]);
    const baseline = (await repo.getAllCases())[0];
    expect(baseline.current_state).toBe("FOLLOWING_UP");
    expect(baseline.operational_cohort?.baselineCodes).toEqual(["A"]);
    await engine.processIncidentFollowups([], undefined, undefined, Date.parse(time(10)), [{ ...order, status: "delivering", fetchedAt: time(10) }]);
    expect((await repo.getAllCases())[0]).toMatchObject({ current_state: "FOLLOWING_UP", current_progress_percent: 100 });
    await engine.processIncidentFollowups([], undefined, undefined, Date.parse(time(20)), [{ ...order, status: "delivered", fetchedAt: time(20) }]);
    expect((await repo.getAllCases())[0].current_state).toBe("RESOLVED");
  });
});
