import { describe, expect, it } from "vitest";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet/types";
import { aggregateEmpiricalTransit, compareReceiveToCot, LaneObservationService, PILOT_LANES, resolveReceiveCotDate } from "@/domain/lane-observation";
import type { LaneObservationRepository, LaneOrderObservationRow, LaneTransitionObservationRow } from "@/domain/lane-observation";

class MemoryRepository implements LaneObservationRepository {
  observations: LaneOrderObservationRow[] = [];
  transitions: LaneTransitionObservationRow[] = [];
  async getLatestByOrderCodes(codes: string[]) {
    const map = new Map<string, LaneOrderObservationRow>();
    for (const row of [...this.observations].sort((a, b) => b.observed_at.localeCompare(a.observed_at))) if (codes.includes(row.order_code) && !map.has(row.order_code)) map.set(row.order_code, row);
    return map;
  }
  async appendOrderObservations(rows: LaneOrderObservationRow[]) {
    const inserted: LaneOrderObservationRow[] = [];
    for (const row of rows) {
      if (this.observations.some((saved) => saved.sync_run_id === row.sync_run_id && saved.order_code === row.order_code)) continue;
      const saved = { ...row, id: `o${this.observations.length + 1}` };
      this.observations.push(saved); inserted.push(saved);
    }
    return inserted;
  }
  async appendTransitions(rows: LaneTransitionObservationRow[]) {
    const fresh = rows.filter((row) => !this.transitions.some((saved) => saved.source_observation_id === row.source_observation_id && saved.target_observation_id === row.target_observation_id));
    this.transitions.push(...fresh); return fresh.length;
  }
  async getCompletedTransitions(from: string, to: string) { return this.transitions.filter((row) => row.from_warehouse_id === from && row.to_warehouse_id === to); }
}

const order = (overrides: Partial<NormalizedRillnetOrder> = {}): NormalizedRillnetOrder => ({
  id: "rillnet-X", orderCode: "X", status: "storing", taskCategory: "Tồn", warehouseId: "22873000", warehouseName: "Đức Hòa", customerId: "c", customerName: "c", customerCode: "c", createdAt: null, deliverWarehouseId: "21712000", deliverWarehouseName: "Tân Bình", warehouseLog: [], fetchedAt: "2026-09-08T07:00:00Z", ...overrides,
});

describe("passive lane observation", () => {
  it("locks exactly the five owner-approved lanes", () => expect(PILOT_LANES).toHaveLength(5));

  it("appends repeated sync history and makes the same sync idempotent", async () => {
    const repo = new MemoryRepository(); const service = new LaneObservationService(repo);
    await service.observe("00000000-0000-0000-0000-000000000001", "2026-09-08T07:00:00Z", [order()]);
    await service.observe("00000000-0000-0000-0000-000000000002", "2026-09-08T08:00:00Z", [order()]);
    await service.observe("00000000-0000-0000-0000-000000000002", "2026-09-08T08:00:00Z", [order()]);
    expect(repo.observations).toHaveLength(2);
  });

  it("continues after FROM, creates a bounded transition, and preserves source event separately", async () => {
    const repo = new MemoryRepository(); const service = new LaneObservationService(repo);
    await service.observe("00000000-0000-0000-0000-000000000001", "2026-09-08T07:00:00Z", [order()]);
    await service.observe("00000000-0000-0000-0000-000000000002", "2026-09-08T11:00:00Z", [order({ warehouseId: "999", warehouseName: "Intermediate", status: "transporting", warehouseLog: [{ warehouse_id: "999", event_at: "2026-09-08T09:15:00Z" }] })]);
    expect(repo.observations).toHaveLength(2);
    expect(repo.transitions[0]).toMatchObject({ transition_window_start: "2026-09-08T07:00:00Z", transition_window_end: "2026-09-08T11:00:00Z", first_observed_at_from: "2026-09-08T07:00:00Z", last_observed_at_from: "2026-09-08T07:00:00Z", first_observed_at_to: "2026-09-08T11:00:00Z", source_event_at: "2026-09-08T09:15:00.000Z" });
    expect(repo.transitions[0]).not.toHaveProperty("departure_at");
  });

  it("ignores non-pilot and does not re-open terminal orders", async () => {
    const repo = new MemoryRepository(); const service = new LaneObservationService(repo);
    await service.observe("00000000-0000-0000-0000-000000000001", "2026-09-08T07:00:00Z", [order({ warehouseId: "nope" })]);
    await service.observe("00000000-0000-0000-0000-000000000002", "2026-09-08T08:00:00Z", [order({ status: "delivered" })]);
    expect(repo.observations).toHaveLength(0);
  });

  it("records the terminal/destination observation once, then stops", async () => {
    const repo = new MemoryRepository(); const service = new LaneObservationService(repo);
    await service.observe("00000000-0000-0000-0000-000000000001", "2026-09-08T07:00:00Z", [order()]);
    await service.observe("00000000-0000-0000-0000-000000000002", "2026-09-08T08:00:00Z", [order({ warehouseId: "21712000", status: "delivered" })]);
    await service.observe("00000000-0000-0000-0000-000000000003", "2026-09-08T09:00:00Z", [order({ warehouseId: "21712000", status: "delivered" })]);
    expect(repo.observations).toHaveLength(2);
  });

  it("uses receive COT, supports N+1, and abstains when unresolved", async () => {
    const n = resolveReceiveCotDate("2026-09-08", "02:00", "2026-09-08T16:59:00.000Z");
    expect(n).toBe("2026-09-08T19:00:00.000Z");
    expect(compareReceiveToCot("2026-09-08T18:00:00Z", n)).toBe("MET");
    expect(compareReceiveToCot("2026-09-08T20:00:00Z", n)).toBe("MISSED");
    expect(compareReceiveToCot("2026-09-08T18:00:00Z", null)).toBe("UNKNOWN");
    const profile = aggregateEmpiricalTransit([{ order_code: "X", from_warehouse_id: "A", to_warehouse_id: "B", transition_window_start: "2026-09-08T00:30:00Z", transition_window_end: "2026-09-08T01:00:00Z", first_observed_at_from: "2026-09-08T00:00:00Z", last_observed_at_from: "2026-09-08T00:30:00Z", first_observed_at_to: "2026-09-08T01:00:00Z", source_observation_id: "1", target_observation_id: "2", cot_result: "UNKNOWN" }]);
    expect(profile.label).toBe("EMPIRICAL_OBSERVED_TRANSIT");
    expect(JSON.stringify(profile)).not.toMatch(/HOLD|DISPATCH|ETA|SLA/);
  });
});
