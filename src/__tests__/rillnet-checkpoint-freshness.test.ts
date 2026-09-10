import { describe, expect, it } from "vitest";
import { isFreshRillnetSnapshot, RILLNET_SNAPSHOT_FRESHNESS_TOLERANCE_MS } from "@/domain/operational-learning/checkpoint-policy";
import { FollowupEngine } from "@/engine/followup/followup-engine";
import { aggregateIncidents } from "@/engine/incident";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet";

const checkpoint = Date.parse("2026-09-10T09:00:00.000Z"); // 16:00 ICT
const currentSnapshotAt = "2026-09-10T08:08:15.537Z"; // real 16h source timestamp

function order(fetchedAt = currentSnapshotAt): NormalizedRillnetOrder {
  return { id: "freshness-order", orderCode: "freshness-order", status: "storing", taskCategory: "Kho tồn", warehouseId: "W", warehouseName: "Kho GHN", customerId: "C", customerName: "C", customerCode: "C", createdAt: "2026-09-10T00:00:00.000Z", deliverWarehouseId: "W", fetchedAt };
}

describe("Rillnet checkpoint snapshot freshness", () => {
  it("processes the current successful 16h snapshot when source lag is within the governed hour", async () => {
    const repo = new MockFollowupRepository();
    const engine = new FollowupEngine(repo);
    const baseline = order("2026-09-10T01:00:00.000Z");
    await engine.processIncidentFollowups(aggregateIncidents([baseline]), undefined, undefined, Date.parse("2026-09-10T01:00:00.000Z"), [baseline]);
    const result = await engine.processIncidentFollowups(aggregateIncidents([order()]), undefined, undefined, checkpoint, [order()]);
    expect(result).toHaveLength(1);
    expect((await repo.getAllCases())[0].operational_cohort?.lastCheckpoint).toBe("2026-09-10:16");
  });

  it("admits all 40 due cohorts to the evaluator when their current snapshot is fresh", async () => {
    const repo = new MockFollowupRepository();
    const engine = new FollowupEngine(repo);
    const baselineOrders = Array.from({ length: 40 }, (_, index) => ({ ...order("2026-09-10T01:00:00.000Z"), id: `due-${index}`, orderCode: `due-${index}`, warehouseId: `W-${index}`, warehouseName: `Kho ${index}`, deliverWarehouseId: `W-${index}` }));
    await engine.processIncidentFollowups(aggregateIncidents(baselineOrders), undefined, undefined, Date.parse("2026-09-10T01:00:00.000Z"), baselineOrders);
    const currentOrders = baselineOrders.map((item) => ({ ...item, fetchedAt: currentSnapshotAt }));
    expect(await engine.processIncidentFollowups(aggregateIncidents(currentOrders), undefined, undefined, checkpoint, currentOrders)).toHaveLength(40);
  });

  it("rejects excessive lag, a prior checkpoint snapshot, and unavailable evidence", () => {
    expect(isFreshRillnetSnapshot(new Date(checkpoint - RILLNET_SNAPSHOT_FRESHNESS_TOLERANCE_MS - 1).toISOString(), checkpoint)).toBe(false);
    expect(isFreshRillnetSnapshot("2026-09-10T07:00:00.000Z", checkpoint)).toBe(false);
    expect(isFreshRillnetSnapshot(null, checkpoint)).toBe(false);
  });
});
