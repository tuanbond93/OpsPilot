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
  PostBarrierWorkPlan,
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
   * Initializes a post-barrier Phase 6 checkpoint work plan.
   * Strictly scopes to post-barrier work:
   * 1. EVALUATE_FOLLOWUP_BATCH (followup case evaluation)
   * 2. PERSIST_MEMBERS_CHUNK (cohort/member hydration & generation)
   * 3. DISPATCH_INTERVENTION_BATCH (dispatch reservation & execution)
   *
   * Pre-barrier work types (INGEST_POPULATION_CHUNK, etc.) are strictly excluded
   * from the post-barrier shadow plan.
   */
  async initializePostBarrierCheckpoint(plan: PostBarrierWorkPlan): Promise<number> {
    const {
      checkpointAt,
      syncRunId,
      caseCount,
      estimatedMembers = 0,
      executionMode = "SHADOW",
      caseBatchSize = this.batchConfig.followupCaseBatchSize || 25,
      memberBatchSize = this.batchConfig.followupMemberBatchSize || 250,
      dispatchBatchSize = 25,
    } = plan;

    if (caseCount <= 0) {
      return 0;
    }

    const inputs = [];

    // 1. Followup Evaluation Batches (Phase 6 state machine evaluation)
    const caseBatchCount = Math.max(1, Math.ceil(caseCount / caseBatchSize));
    for (let i = 0; i < caseBatchCount; i++) {
      const offset = i * caseBatchSize;
      const limit = Math.min(caseBatchSize, caseCount - offset);
      const partitionKey = `followup_batch_${i}_of_${caseBatchCount}`;
      const idempotencyKey = `${checkpointAt}:${syncRunId}:${executionMode}:FOLLOWUPS_PROCESSING:EVALUATE_FOLLOWUP_BATCH:${partitionKey}`;
      inputs.push({
        checkpointAt,
        syncRunId,
        stage: "FOLLOWUPS_PROCESSING" as CheckpointStage,
        workType: "EVALUATE_FOLLOWUP_BATCH" as WorkUnitType,
        partitionKey,
        cursor: { offset, limit, total: caseCount },
        executionMode,
        idempotencyKey,
      });
    }

    // 2. Member Hydration & Generation Batches
    const memberTotal = estimatedMembers > 0 ? estimatedMembers : Math.max(caseCount * 25, 25);
    const memberBatchCount = Math.max(1, Math.ceil(memberTotal / memberBatchSize));
    for (let i = 0; i < memberBatchCount; i++) {
      const offset = i * memberBatchSize;
      const limit = Math.min(memberBatchSize, memberTotal - offset);
      const partitionKey = `member_chunk_${i}_of_${memberBatchCount}`;
      const idempotencyKey = `${checkpointAt}:${syncRunId}:${executionMode}:FOLLOWUPS_PROCESSING:PERSIST_MEMBERS_CHUNK:${partitionKey}`;
      inputs.push({
        checkpointAt,
        syncRunId,
        stage: "FOLLOWUPS_PROCESSING" as CheckpointStage,
        workType: "PERSIST_MEMBERS_CHUNK" as WorkUnitType,
        partitionKey,
        cursor: { offset, limit, total: memberTotal },
        executionMode,
        idempotencyKey,
      });
    }

    // 3. Dispatch Intervention Batches
    const dispatchBatchCount = Math.max(1, Math.ceil(caseCount / dispatchBatchSize));
    for (let i = 0; i < dispatchBatchCount; i++) {
      const offset = i * dispatchBatchSize;
      const limit = Math.min(dispatchBatchSize, caseCount - offset);
      const partitionKey = `dispatch_batch_${i}_of_${dispatchBatchCount}`;
      const idempotencyKey = `${checkpointAt}:${syncRunId}:${executionMode}:DISPATCH_PROCESSING:DISPATCH_INTERVENTION_BATCH:${partitionKey}`;
      inputs.push({
        checkpointAt,
        syncRunId,
        stage: "DISPATCH_PROCESSING" as CheckpointStage,
        workType: "DISPATCH_INTERVENTION_BATCH" as WorkUnitType,
        partitionKey,
        cursor: { offset, limit, total: caseCount },
        executionMode,
        idempotencyKey,
      });
    }

    return this.workQueueRepo.createWorkUnits(inputs);
  }

  /**
   * Initializes a new checkpoint by partitioning the ingestion stage into bounded work units.
   * Kept for backwards compatibility with raw ingestion benchmarks.
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
