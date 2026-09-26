/**
 * Checkpoint Pipeline V2 - Bounded Checkpoint Worker
 *
 * Pulls and processes work units under a strict internal soft time budget.
 * Invariant: Increasing order volume increases work units, not worker execution time.
 * Under no circumstances does a worker run to the 300-second serverless ceiling.
 */

import type {
  CheckpointWorkUnit,
  WorkerBudgetConfig,
  WorkerInvocationSummary,
  CheckpointStage,
  ExecutionMode,
} from "@/domain/checkpoint-v2/types";
import { DEFAULT_WORKER_BUDGET } from "@/domain/checkpoint-v2/types";
import type { ICheckpointWorkQueueRepository } from "@/repositories/interfaces/ICheckpointWorkQueueRepository";

export type WorkUnitExecutionHandler = (
  unit: CheckpointWorkUnit,
  workerId: string
) => Promise<{ itemsProcessed: number }>;

export class CheckpointWorker {
  public readonly workerId: string;

  constructor(
    private workQueueRepo: ICheckpointWorkQueueRepository,
    private budgetConfig: WorkerBudgetConfig = DEFAULT_WORKER_BUDGET,
    workerIdPrefix: string = "worker"
  ) {
    this.workerId = `${workerIdPrefix}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  }

  /**
   * Runs the worker loop for a given checkpoint until work is exhausted or the soft budget is reached.
   */
  async runLoop(
    checkpointAt: string,
    syncRunId: string,
    handler: WorkUnitExecutionHandler,
    executionMode: ExecutionMode = "PRODUCTION"
  ): Promise<WorkerInvocationSummary> {
    const startedAt = performance.now();
    let claimedCount = 0;
    let completedCount = 0;
    let failedCount = 0;
    let totalItemsProcessed = 0;
    let softBudgetYielded = false;
    let currentStage: CheckpointStage = "CREATED";

    let observedMsPerItem = 1.0; // Initial conservative estimate: 1ms/item
    const safeTailMarginMs = this.budgetConfig.safeTailMarginMs ?? 12_000;

    for (;;) {
      const elapsed = performance.now() - startedAt;
      const remainingBudgetMs = this.budgetConfig.softBudgetMs - elapsed;

      // 1. Soft Budget Guard: stop claiming new work when remaining budget is below safe tail margin
      if (remainingBudgetMs <= safeTailMarginMs) {
        softBudgetYielded = true;
        break;
      }

      // 2. Adaptive Batch Calculation
      const targetItems = Math.max(50, Math.floor(remainingBudgetMs / Math.max(0.1, observedMsPerItem)));
      const batchLimit = Math.min(5, Math.max(1, Math.ceil(targetItems / 500)));

      // 3. Claim claimable work units for this checkpoint and execution mode
      const units = await this.workQueueRepo.claimWorkUnits(
        checkpointAt,
        this.workerId,
        this.budgetConfig.leaseDurationMs,
        batchLimit,
        executionMode
      );

      if (units.length === 0) {
        // No pending or expired leased work currently available for this checkpoint
        break;
      }

      claimedCount += units.length;

      // 4. Process each claimed unit
      for (let i = 0; i < units.length; i++) {
        const currentElapsed = performance.now() - startedAt;
        const currentRemaining = this.budgetConfig.softBudgetMs - currentElapsed;

        // Budget Hardening: Never start a new work unit if remaining budget is below safe tail margin.
        // Release unstarted units back to PENDING immediately so continuation can pick them up cleanly.
        if (i > 0 && currentRemaining <= safeTailMarginMs) {
          const unstartedIds = units.slice(i).map((u) => u.id);
          await this.workQueueRepo.releaseWorkUnits(unstartedIds, this.workerId);
          softBudgetYielded = true;
          break;
        }

        const unit = units[i];
        currentStage = unit.stage;
        const unitStart = performance.now();

        try {
          // Execute handler (atomic execution unit)
          const result = await handler(unit, this.workerId);
          totalItemsProcessed += result.itemsProcessed;

          // Mark completed
          await this.workQueueRepo.completeWorkUnit(unit.id, this.workerId);
          completedCount++;

          // Calibrate observed speed
          const unitDuration = performance.now() - unitStart;
          if (result.itemsProcessed > 0) {
            observedMsPerItem = (observedMsPerItem * 0.7) + ((unitDuration / result.itemsProcessed) * 0.3);
          }
        } catch (error: any) {
          failedCount++;
          const retryable = error?.retryable !== false;
          await this.workQueueRepo.failWorkUnit(unit.id, this.workerId, {
            failureCode: error?.code || "WORK_UNIT_EXECUTION_ERROR",
            message: error?.message || String(error),
            retryable,
            retryAfterMs: 3_000,
          });
          if (error?.isCrash || String(error?.message).includes("CRASH")) {
            throw error; // Process dies on fatal crash
          }
        }

        // Intra-batch warning threshold check: release remaining units if reached
        if (performance.now() - startedAt >= this.budgetConfig.warningBudgetMs) {
          if (i + 1 < units.length) {
            const unstartedIds = units.slice(i + 1).map((u) => u.id);
            await this.workQueueRepo.releaseWorkUnits(unstartedIds, this.workerId);
          }
          softBudgetYielded = true;
          break;
        }
      }

      if (softBudgetYielded) break;
    }

    return {
      workerId: this.workerId,
      checkpointAt,
      syncRunId,
      invocationDurationMs: Math.round(performance.now() - startedAt),
      workUnitsClaimed: claimedCount,
      workUnitsCompleted: completedCount,
      workUnitsFailed: failedCount,
      itemsProcessed: totalItemsProcessed,
      softBudgetYielded,
      stageReached: currentStage,
    };
  }
}
