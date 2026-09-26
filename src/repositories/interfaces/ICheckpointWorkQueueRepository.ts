import type {
  CheckpointWorkUnit,
  CheckpointObservabilitySnapshot,
  WorkUnitStatus,
} from "@/domain/checkpoint-v2/types";

export interface CreateWorkUnitInput {
  checkpointAt: string;
  syncRunId: string;
  stage: CheckpointWorkUnit["stage"];
  workType: CheckpointWorkUnit["workType"];
  partitionKey: string;
  cursor: CheckpointWorkUnit["cursor"];
  idempotencyKey: string;
  executionMode?: "PRODUCTION" | "SHADOW";
  maxAttempts?: number;
}

export interface ICheckpointWorkQueueRepository {
  createWorkUnits(units: CreateWorkUnitInput[]): Promise<number>;
  claimWorkUnits(
    checkpointAt: string,
    workerId: string,
    leaseDurationMs: number,
    limit: number,
    executionMode?: "PRODUCTION" | "SHADOW"
  ): Promise<CheckpointWorkUnit[]>;
  releaseWorkUnits(ids: string[], workerId: string): Promise<void>;
  completeWorkUnit(id: string, workerId: string): Promise<void>;
  failWorkUnit(
    id: string,
    workerId: string,
    error: {
      failureCode: string;
      message: string;
      retryable: boolean;
      retryAfterMs?: number;
    }
  ): Promise<void>;
  renewLease(id: string, workerId: string, extensionMs: number): Promise<boolean>;
  getWorkUnitsForCheckpoint(checkpointAt: string): Promise<CheckpointWorkUnit[]>;
  getObservabilitySnapshot(
    checkpointAt: string,
    syncRunId: string
  ): Promise<CheckpointObservabilitySnapshot>;
}
