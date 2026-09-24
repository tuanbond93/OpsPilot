import { describe, expect, it } from "vitest";
import { FollowupEngine } from "@/engine/followup/followup-engine";
import type { Incident } from "@/engine/incident";
import type { IFollowupRepository } from "@/repositories/interfaces/IFollowupRepository";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";
import {
  FOLLOWUP_CASE_UPSERT_MAX_PAYLOAD_BYTES,
  FOLLOWUP_CASE_UPSERT_MAX_ROWS,
  followupCaseUpsertPayloadBytes,
} from "@/engine/followup/upsert-batching";

const referenceTime = Date.parse("2026-09-14T03:00:00.000Z");

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
  readonly caseBatchPayloadBytes: number[] = [];

  override async batchUpsertCases(cases: Parameters<IFollowupRepository["batchUpsertCases"]>[0]) {
    this.caseBatchSizes.push(cases.length);
    const payloadBytes = followupCaseUpsertPayloadBytes(cases);
    this.caseBatchPayloadBytes.push(payloadBytes);
    if (cases.length > FOLLOWUP_CASE_UPSERT_MAX_ROWS || payloadBytes > FOLLOWUP_CASE_UPSERT_MAX_PAYLOAD_BYTES) {
      throw new Error("follow-up batch exceeded configured row or payload bound");
    }
    return super.batchUpsertCases(cases);
  }
}

describe("follow-up persistence checkpoint scale", () => {
  for (const count of [300, 500, 1063]) {
    it(`persists ${count} incident mutations in bounded chunks with unchanged case and event semantics`, async () => {
      const repository = new StatementBoundedRepository();
      const engine = new FollowupEngine(repository);
      const startedAt = performance.now();

      const results = await engine.processIncidentFollowups(incidents(count), new Map(), undefined, referenceTime);
      const elapsedMs = performance.now() - startedAt;

      expect(results).toHaveLength(count);
      expect(repository.caseBatchSizes).toEqual(Array(Math.ceil(count / FOLLOWUP_CASE_UPSERT_MAX_ROWS)).fill(FOLLOWUP_CASE_UPSERT_MAX_ROWS).map((size, index, batches) => index === batches.length - 1 ? count - FOLLOWUP_CASE_UPSERT_MAX_ROWS * index : size));
      expect(repository.caseBatchSizes.every(size => size <= FOLLOWUP_CASE_UPSERT_MAX_ROWS)).toBe(true);
      expect(repository.caseBatchPayloadBytes.every(size => size <= FOLLOWUP_CASE_UPSERT_MAX_PAYLOAD_BYTES)).toBe(true);
      expect(await repository.getAllCases()).toHaveLength(count);
      expect(await repository.getRecentEvents(count + 1)).toHaveLength(count);
      expect(engine.getLastRunMetrics()).toMatchObject({ incidents: count, caseWrites: Math.ceil(count / FOLLOWUP_CASE_UPSERT_MAX_ROWS), eventWrites: 1, status: "success" });
      expect(elapsedMs).toBeLessThan(10_000);
    });
  }
});
