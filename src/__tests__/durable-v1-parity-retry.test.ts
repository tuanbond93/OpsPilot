import { describe, expect, it } from "vitest";
import { FollowupEngine, type DurableV1FollowupPlan } from "@/engine/followup/followup-engine";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";
import type { Incident } from "@/engine/incident";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet/types";

const checkpoint = Date.parse("2026-09-27T11:00:00.000Z");
const runId = "33333333-3333-4333-8333-333333333333";

function fixture(count: number) {
  const incidents: Incident[] = [];
  const orders: NormalizedRillnetOrder[] = [];
  for (let index = 0; index < count; index++) {
    const code = `ORDER-${index}`;
    incidents.push({
      incidentId: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
      incidentKey: `warehouse-${index}:KHO_TON`,
      warehouseId: `warehouse-${index}`, warehouseName: `Warehouse ${index}`,
      reasonCode: "KHO_TON", reasonName: "Stock backlog", status: "monitoring",
      priorityScore: 75, firstDetectedAt: "2026-09-26T11:00:00.000Z",
      lastDetectedAt: "2026-09-27T11:00:00.000Z", affectedOrderCount: 1,
      affectedOrders: [code], sampleOrderCodes: [code], averageAgeHours: 24,
      maximumAgeHours: 24, oldestOrderCode: code,
    });
    orders.push({
      id: code, orderCode: code, status: "storing", taskCategory: "Kho tồn",
      warehouseId: `warehouse-${index}`, warehouseName: `Warehouse ${index}`,
      customerId: `customer-${index}`, customerName: `Customer ${index}`,
      customerCode: `customer-${index}`, createdAt: "2026-09-26T09:00:00.000Z",
      deliverWarehouseId: "destination", fetchedAt: "2026-09-27T11:00:00.000Z",
      warehouseLog: [],
    });
  }
  return { incidents, orders };
}

async function result(repo: MockFollowupRepository) {
  const cases = await repo.getAllCases();
  const events = (await Promise.all(cases.map(item => repo.getEventsByCaseId(item.id)))).flat();
  return {
    cases: cases.map(item => ({ key: item.incident_key, state: item.current_state,
      generation: item.member_generation_id, cohort: item.operational_cohort })).sort((a, b) => a.key.localeCompare(b.key)),
    events: events.map(item => ({ key: item.durable_work_key, type: item.event_type,
      oldState: item.old_state, newState: item.new_state })).sort((a, b) => String(a.key).localeCompare(String(b.key))),
  };
}

describe("durable V1 follow-up parity and replay", () => {
  it("matches the unpartitioned V1 case, member, generation, and transition outputs", async () => {
    const { incidents, orders } = fixture(540);
    const legacyRepo = new MockFollowupRepository();
    const durableRepo = new MockFollowupRepository();
    await new FollowupEngine(legacyRepo).processIncidentFollowups(incidents, new Map(), undefined, checkpoint, orders, runId);
    for (let start = 0; start < incidents.length; start += 25) {
      const cohort = incidents.slice(start, start + 25);
      await new FollowupEngine(durableRepo).processIncidentFollowups(cohort, new Map(), undefined, checkpoint,
        orders, runId, { existingCases: [], journalPlan: async () => undefined });
    }
    const legacy = await result(legacyRepo);
    const durable = await result(durableRepo);
    expect(durable.cases).toEqual(legacy.cases);
    expect(durable.events.map(({ key: _key, ...event }) => event))
      .toEqual(legacy.events.map(({ key: _key, ...event }) => event));
  });

  it("replays a journaled new case after an interrupted write without duplicate events or parents", async () => {
    const { incidents, orders } = fixture(1);
    const repo = new MockFollowupRepository();
    const engine = new FollowupEngine(repo);
    let plan: DurableV1FollowupPlan | undefined;
    await engine.processIncidentFollowups(incidents, new Map(), undefined, checkpoint, orders, runId,
      { existingCases: [], journalPlan: async value => { plan = value; } });
    expect(plan).toBeDefined();
    const first = await result(repo);
    await engine.replayDurableV1Plan(plan!, runId);
    const second = await result(repo);
    expect(second.cases).toEqual(first.cases);
    expect(second.events).toEqual(first.events);
    expect(second.cases).toHaveLength(1);
    expect(second.events).toHaveLength(1);
  });
});
