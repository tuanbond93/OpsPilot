import { describe, expect, it } from "vitest";
import { CheckpointDispatchLedger, InMemoryDispatchLedgerStorage } from "@/engine/checkpoint-v2/dispatch-ledger";
import { CheckpointOrchestrator } from "@/engine/checkpoint-v2/checkpoint-orchestrator";
import { CheckpointWorker } from "@/engine/checkpoint-v2/checkpoint-worker";
import { PostBarrierShadowHandler } from "@/engine/checkpoint-v2/post-barrier-handler";
import { createFourScenarioParityFixtures } from "@/engine/checkpoint-v2/four-scenario-parity-harness";
import { MockCheckpointWorkQueueRepository } from "@/repositories/mock/MockCheckpointWorkQueueRepository";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";

async function runFixture(index: number) {
  const fixture = createFourScenarioParityFixtures("no-action-dispatch-regression")[index];
  const followupRepo = new MockFollowupRepository();
  if (fixture.priorCase) await followupRepo.upsertCase(fixture.priorCase);
  const queue = new MockCheckpointWorkQueueRepository();
  const storage = new InMemoryDispatchLedgerStorage();
  const handler = new PostBarrierShadowHandler({ followupRepo, dispatchLedgerStorage: storage });
  await new CheckpointOrchestrator(queue).initializePostBarrierCheckpoint({
    checkpointAt: fixture.checkpointAt,
    syncRunId: fixture.syncRunId,
    caseCount: 1,
    executionMode: "SHADOW",
  });
  await new CheckpointWorker(queue, undefined, "no-action-regression").runLoop(
    fixture.checkpointAt,
    fixture.syncRunId,
    handler.createExecutionHandler(fixture.orders, [fixture.incident]),
    "SHADOW",
  );
  const persistedCase = (await followupRepo.getCasesByIncidentKeys([fixture.incident.incidentKey]))[0];
  return { fixture, handler, storage, persistedCase };
}

describe("Checkpoint V2 no-action dispatch regression", () => {
  it("creates no SHADOW dispatch reservation for FOLLOWING_UP monitoring", async () => {
    const { fixture, handler, storage, persistedCase } = await runFixture(1);
    const key = CheckpointDispatchLedger.buildIdempotencyKey(
      fixture.checkpointAt, persistedCase.id, "TELEGRAM_FIRST_PUSH",
    );
    expect(handler.getShadowDecisions(fixture.checkpointAt, fixture.syncRunId)[0]).toMatchObject({
      decisionType: "MONITORING", actionType: null,
    });
    expect(handler.getExecutionState(fixture.checkpointAt, fixture.syncRunId)?.telegramSuppressedCount).toBe(0);
    expect(await storage.getByDedupeKey(key)).toBeNull();
  });

  it("keeps the governed first-push intervention", async () => {
    const { fixture, handler, storage, persistedCase } = await runFixture(0);
    const key = CheckpointDispatchLedger.buildIdempotencyKey(
      fixture.checkpointAt, persistedCase.id, "TELEGRAM_FIRST_PUSH",
    );
    expect(handler.getShadowDecisions(fixture.checkpointAt, fixture.syncRunId)[0]).toMatchObject({
      decisionType: "ACTION_REQUESTED", actionType: "FIRST_PUSH",
    });
    expect(handler.getExecutionState(fixture.checkpointAt, fixture.syncRunId)?.telegramSuppressedCount).toBe(1);
    expect(await storage.getByDedupeKey(key)).toMatchObject({ status: "CONFIRMED", executionMode: "SHADOW" });
  });
});
