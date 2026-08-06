import { describe, expect, it } from "vitest";
import { ActionQueue, Deduplicator, type EnqueueActionParams } from "@/engine/action-queue";
import { FollowupEngine } from "@/engine/followup";
import type { Incident } from "@/engine/incident";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";

const referenceTimeMs = Date.parse("2026-08-06T00:00:00.000Z");

function makeIncident(index: number): Incident {
  return {
    incidentId: "control-incident-" + index,
    incidentKey: "control:" + index,
    warehouseId: "control-warehouse-" + index,
    warehouseName: "Control warehouse " + index,
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
    oldestOrderCode: "CONTROL-" + index,
  };
}

class CountingActionQueue extends ActionQueue {
  enqueueCalls = 0;

  override async enqueueAction(
    params: EnqueueActionParams
  ): ReturnType<ActionQueue["enqueueAction"]> {
    this.enqueueCalls++;
    return super.enqueueAction(params);
  }
}

describe("controlled follow-up runtime", () => {
  it("measures 5- and 25-incident fixtures without production filtering", async () => {
    for (const incidentCount of [5, 25]) {
      Deduplicator.clearMemory();
      const repository = new MockFollowupRepository();
      const actions = new CountingActionQueue(null);
      const engine = new FollowupEngine(repository, actions);
      const startedAt = performance.now();
      const results = await engine.processIncidentFollowups(
        Array.from({ length: incidentCount }, (_, index) => makeIncident(index + 1)),
        new Map(),
        undefined,
        referenceTimeMs
      );
      const fullDurationMs = Math.round((performance.now() - startedAt) * 100) / 100;
      const metrics = engine.getLastRunMetrics();
      const queueMetrics = metrics?.actionQueueMetrics;

      console.log(
        "[ControlledFollowupRuntime] " +
          JSON.stringify({
            incidents: incidentCount,
            processFollowupsDurationMs: metrics?.durationMs ?? fullDurationMs,
            enqueueActionsDurationMs: metrics?.operationDurationsMs.actionEnqueue ?? 0,
            fullFixtureDurationMs: fullDurationMs,
            queryCount:
              (metrics?.caseReads ?? 0) +
              (metrics?.caseWrites ?? 0) +
              (metrics?.eventWrites ?? 0) +
              (queueMetrics?.dedupLookups ?? 0) +
              (queueMetrics?.actionInsertCalls ?? 0) +
              (queueMetrics?.auditEventWrites ?? 0),
            success: results.length === incidentCount,
          })
      );

      expect(results).toHaveLength(incidentCount);
      expect(metrics?.status).toBe("success");
    }
  });
});
