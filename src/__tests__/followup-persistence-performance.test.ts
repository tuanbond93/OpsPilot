import { describe, expect, it } from "vitest";
import { FollowupEngine } from "@/engine/followup/followup-engine";
import type { Incident } from "@/engine/incident";
import type { IFollowupRepository } from "@/repositories/interfaces/IFollowupRepository";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";

const referenceTime = Date.parse("2026-09-14T03:00:00.000Z");
const STATEMENT_SAFE_BATCH_SIZE = 50;

function incidents(count: number): Incident[] {
  return Array.from({ length: count }, (_, index) => ({
    incidentId: `incident-${index}`,
    incidentKey: `warehouse-${index}:KHO_TON`,
    warehouseId: `warehouse-${index}`,
    warehouseName: `Warehouse ${index}`,
    reasonCode: "KHO_TON",
    reasonName: "Stock backlog",
    status: "open",
    priorityScore: 75,
    firstDetectedAt: "2026-09-13T03:00:00.000Z",
    lastDetectedAt: "2026-09-14T03:00:00.000Z",
    affectedOrderCount: 10,
    sampleOrderCodes: [`order-${index}`],
    averageAgeHours: 24,
    maximumAgeHours: 24,
    oldestOrderCode: `order-${index}`,
  }));
}

class StatementBoundedRepository extends MockFollowupRepository {
  readonly caseBatchSizes: number[] = [];

  override async batchUpsertCases(cases: Parameters<IFollowupRepository["batchUpsertCases"]>[0]) {
    this.caseBatchSizes.push(cases.length);
    if (cases.length > STATEMENT_SAFE_BATCH_SIZE) {
      throw new Error("canceling statement due to statement timeout");
    }
    return super.batchUpsertCases(cases);
  }
}

describe("follow-up persistence checkpoint scale", () => {
  for (const count of [300, 500]) {
    it(`persists ${count} incident mutations in statement-safe chunks with unchanged case and event semantics`, async () => {
      const repository = new StatementBoundedRepository();
      const engine = new FollowupEngine(repository);
      const startedAt = performance.now();

      const results = await engine.processIncidentFollowups(incidents(count), new Map(), undefined, referenceTime);
      const elapsedMs = performance.now() - startedAt;

      expect(results).toHaveLength(count);
      expect(repository.caseBatchSizes).toEqual(Array(Math.ceil(count / STATEMENT_SAFE_BATCH_SIZE)).fill(STATEMENT_SAFE_BATCH_SIZE).map((size, index, batches) => index === batches.length - 1 ? count - STATEMENT_SAFE_BATCH_SIZE * index : size));
      expect(await repository.getAllCases()).toHaveLength(count);
      expect(await repository.getRecentEvents(count + 1)).toHaveLength(count);
      expect(engine.getLastRunMetrics()).toMatchObject({ incidents: count, caseWrites: Math.ceil(count / STATEMENT_SAFE_BATCH_SIZE), eventWrites: 1, status: "success" });
      expect(elapsedMs).toBeLessThan(5_000);
    });
  }
});
