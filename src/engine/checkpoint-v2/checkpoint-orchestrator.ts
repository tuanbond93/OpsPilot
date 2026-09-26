/**
 * Checkpoint Pipeline V2 - Checkpoint Orchestrator
 *
 * Decomposes checkpoint work into bounded, partitionable, durable work units.
 * Controls stage progression and enforces strict checkpoint identity isolation:
 * Checkpoint T never adopts or pollutes Checkpoint T+1.
 */

import type {
  CheckpointStage,
  WorkUnitType,
  WorkerBatchConfig,
  ExecutionMode,
} from "@/domain/checkpoint-v2/types";
import { DEFAULT_BATCH_CONFIG } from "@/domain/checkpoint-v2/types";
import type { ICheckpointWorkQueueRepository } from "@/repositories/interfaces/ICheckpointWorkQueueRepository";

export interface StagePartitionPlan {
  stage: CheckpointStage;
  workType: WorkUnitType;
  totalItems: number;
  batchSize: number;
  partitionKeyPrefix: string;
  executionMode?: ExecutionMode;
}

export class CheckpointOrchestrator {
  constructor(
    private workQueueRepo: ICheckpointWorkQueueRepository,
    private batchConfig: WorkerBatchConfig = DEFAULT_BATCH_CONFIG
  ) {}

  /**
   * Initializes a new checkpoint by partitioning the ingestion stage into bounded work units.
   */
  async initializeCheckpoint(
    checkpointAt: string,
    syncRunId: string,
    totalOrders: number,
    executionMode: ExecutionMode = "PRODUCTION"
  ): Promise<number> {
    return this.planAndEnqueueStageWork(checkpointAt, syncRunId, {
      stage: "INGESTING",
      workType: "INGEST_POPULATION_CHUNK",
      totalItems: totalOrders,
      batchSize: this.batchConfig.orderBatchSize,
      partitionKeyPrefix: "pop_chunk",
      executionMode,
    });
  }

  /**
   * Checks whether the current stage work units are all complete.
   * If complete, advances to the next stage and plans the next work units.
   */
  async advanceStageIfComplete(
    checkpointAt: string,
    syncRunId: string,
    currentStage: CheckpointStage,
    nextStageInput: {
      nextStage: CheckpointStage;
      workType: WorkUnitType;
      totalItems: number;
      batchSize?: number;
      partitionKeyPrefix: string;
      executionMode?: ExecutionMode;
    }
  ): Promise<{ advanced: boolean; newWorkUnitsCreated: number }> {
    const units = await this.workQueueRepo.getWorkUnitsForCheckpoint(checkpointAt);
    const stageUnits = units.filter((u) => u.stage === currentStage);

    if (stageUnits.length === 0) {
      return { advanced: false, newWorkUnitsCreated: 0 };
    }

    const allCompleted = stageUnits.every((u) => u.status === "COMPLETED");
    if (!allCompleted) {
      return { advanced: false, newWorkUnitsCreated: 0 };
    }

    // Stage is complete, generate work units for next stage
    const created = await this.planAndEnqueueStageWork(checkpointAt, syncRunId, {
      stage: nextStageInput.nextStage,
      workType: nextStageInput.workType,
      totalItems: nextStageInput.totalItems,
      batchSize: nextStageInput.batchSize || this.batchConfig.orderBatchSize,
      partitionKeyPrefix: nextStageInput.partitionKeyPrefix,
      executionMode: nextStageInput.executionMode,
    });

    return { advanced: true, newWorkUnitsCreated: created };
  }

  /**
   * Helper to partition an item count into discrete, idempotent work units.
   */
  private async planAndEnqueueStageWork(
    checkpointAt: string,
    syncRunId: string,
    plan: StagePartitionPlan
  ): Promise<number> {
    const { stage, workType, totalItems, batchSize, partitionKeyPrefix, executionMode = "PRODUCTION" } = plan;
    const workUnitCount = Math.max(1, Math.ceil(totalItems / batchSize));
    const inputs = [];

    for (let i = 0; i < workUnitCount; i++) {
      const offset = i * batchSize;
      const limit = Math.min(batchSize, totalItems - offset);
      const partitionKey = `${partitionKeyPrefix}_${i}_of_${workUnitCount}`;
      const idempotencyKey = `${checkpointAt}:${syncRunId}:${executionMode}:${stage}:${workType}:${partitionKey}`;

      inputs.push({
        checkpointAt,
        syncRunId,
        stage,
        workType,
        partitionKey,
        cursor: {
          offset,
          limit: limit > 0 ? limit : batchSize,
          total: totalItems,
        },
        executionMode,
        idempotencyKey,
      });
    }

    return this.workQueueRepo.createWorkUnits(inputs);
  }
}
