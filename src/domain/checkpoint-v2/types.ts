/**
 * Checkpoint Pipeline V2 - Core Domain Types
 *
 * Defines the durable checkpoint state machine, work unit contracts,
 * lease models, worker budget controls, and metrics collection.
 */

export type CheckpointStage =
  | "CREATED"
  | "INGESTING"
  | "INGESTION_COMPLETE"
  | "FOLLOWUPS_PENDING"
  | "FOLLOWUPS_PROCESSING"
  | "FOLLOWUPS_COMPLETE"
  | "DISPATCH_PENDING"
  | "DISPATCH_PROCESSING"
  | "COMPLETE"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL";

export type WorkUnitType =
  | "INGEST_POPULATION_CHUNK"
  | "PERSIST_SNAPSHOT_CHUNK"
  | "EVALUATE_INCIDENTS_CHUNK"
  | "PERSIST_HISTORY_CHUNK"
  | "EVALUATE_FOLLOWUP_BATCH"
  | "PERSIST_MEMBERS_CHUNK"
  | "DISPATCH_INTERVENTION_BATCH";

export type WorkUnitStatus = "PENDING" | "LEASED" | "COMPLETED" | "FAILED";

export interface WorkUnitCursor {
  offset: number;
  limit: number;
  total?: number;
  partitionKey?: string;
  metadata?: Record<string, unknown>;
}

export type ExecutionMode = "PRODUCTION" | "SHADOW";

export interface CheckpointWorkUnit {
  id: string;
  checkpointAt: string;
  syncRunId: string;
  stage: CheckpointStage;
  workType: WorkUnitType;
  partitionKey: string;
  cursor: WorkUnitCursor;
  status: WorkUnitStatus;
  executionMode?: ExecutionMode;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  idempotencyKey: string;
  startedAt: string | null;
  completedAt: string | null;
  failureCode: string | null;
  lastSafeError: string | null;
  retryAfter: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerBudgetConfig {
  /** Target execution time for a normal invocation (default: 45,000ms = 45s) */
  softBudgetMs: number;
  /** Safe tail margin: stop claiming/starting new work when remaining budget <= safeTailMarginMs (default: 12,000ms = 12s) */
  safeTailMarginMs?: number;
  /** Warning threshold where no new batches should be started (default: 75,000ms = 75s) */
  warningBudgetMs: number;
  /** Hard cutoff threshold where the worker must yield immediately (default: 150,000ms = 150s) */
  criticalBudgetMs: number;
  /** Platform hard ceiling limit (Vercel maxDuration: 300,000ms = 300s) */
  platformCeilingMs: number;
  /** Default lease duration granted to a worker on a work unit (default: 60,000ms = 60s) */
  leaseDurationMs: number;
}

export const DEFAULT_WORKER_BUDGET: WorkerBudgetConfig = {
  softBudgetMs: 45_000,
  safeTailMarginMs: 12_000,
  warningBudgetMs: 75_000,
  criticalBudgetMs: 150_000,
  platformCeilingMs: 300_000,
  leaseDurationMs: 60_000,
};

export interface WorkerBatchConfig {
  orderBatchSize: number;
  incidentBatchSize: number;
  followupCaseBatchSize: number;
  followupMemberBatchSize: number;
  concurrencyLimit: number;
}

export const DEFAULT_BATCH_CONFIG: WorkerBatchConfig = {
  orderBatchSize: 1_000,
  incidentBatchSize: 500,
  followupCaseBatchSize: 25,
  followupMemberBatchSize: 250,
  concurrencyLimit: 5,
};

export interface DispatchLedgerEntry {
  id: string;
  checkpointAt: string;
  syncRunId: string;
  caseId: string;
  incidentKey: string;
  interventionType: string;
  sequence: number;
  idempotencyKey: string;
  status: "RESERVED" | "DISPATCHED" | "CONFIRMED" | "FAILED";
  executionMode?: ExecutionMode;
  telegramMessageId?: string | null;
  payloadSummary?: Record<string, unknown> | null;
  reservedAt: string;
  dispatchedAt?: string | null;
  confirmedAt?: string | null;
  failureReason?: string | null;
}

export interface WorkerInvocationSummary {
  workerId: string;
  checkpointAt: string;
  syncRunId: string;
  invocationDurationMs: number;
  workUnitsClaimed: number;
  workUnitsCompleted: number;
  workUnitsFailed: number;
  itemsProcessed: number;
  softBudgetYielded: boolean;
  stageReached: CheckpointStage;
}

export interface CheckpointObservabilitySnapshot {
  checkpointAt: string;
  syncRunId: string;
  stage: CheckpointStage;
  totalWorkUnits: number;
  pendingUnits: number;
  leasedUnits: number;
  completedUnits: number;
  failedUnits: number;
  queueAgeMs: number;
  oldestWorkAgeMs: number;
  activeWorkerCount: number;
  isStalled: boolean;
  estimatedRemainingTimeMs: number;
}
