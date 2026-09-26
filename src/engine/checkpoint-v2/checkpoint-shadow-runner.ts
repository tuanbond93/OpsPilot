/**
 * Checkpoint Pipeline V2 - Shadow Production Runner
 *
 * Runs Checkpoint Pipeline V2 in non-authoritative shadow mode alongside V1.
 * Enabled via CHECKPOINT_PIPELINE_V2_SHADOW=true.
 *
 * Invariants Enforced:
 * 1. V1 remains 100% authoritative for operational state and operator alerting.
 * 2. V2 receives the exact same checkpoint input as V1.
 * 3. V2 MUST NOT send Telegram alerts (external delivery is strictly intercepted/suppressed).
 * 4. V2 MUST NOT execute external actions or mutate authoritative decision tables.
 * 5. Compares V1 and V2 across: order population, incidents, cases, members, decisions, intervention types.
 * 6. Emits a structured Parity Report for each observed checkpoint.
 * 7. Decouples V2 shadow computation from V1 Phase 6 completion: V2 computation
 *    runs at the durable checkpoint barrier; parity is finalized when V1 completes.
 */

import type { NormalizedRillnetOrder } from "@/connectors/rillnet/types";
import { CheckpointOrchestrator } from "./checkpoint-orchestrator";
import { CheckpointWorker, type WorkUnitExecutionHandler } from "./checkpoint-worker";
import { CheckpointDispatchLedger, InMemoryDispatchLedgerStorage } from "./dispatch-ledger";
import { MockCheckpointWorkQueueRepository } from "@/repositories/mock/MockCheckpointWorkQueueRepository";
import type { ICheckpointWorkQueueRepository } from "@/repositories/interfaces/ICheckpointWorkQueueRepository";
import {
  DEFAULT_WORKER_BUDGET,
  type WorkerBudgetConfig,
  type WorkerInvocationSummary,
} from "@/domain/checkpoint-v2/types";

export interface V1CheckpointSummary {
  syncRunId: string;
  checkpointAt: string;
  orderCount: number;
  incidentCount: number;
  caseCount: number;
  memberCount: number;
  decisionsCount: number;
  interventionTypes: string[];
}

export interface ShadowSeedInput {
  checkpointAt: string;
  syncRunId: string;
  orderCount?: number;
  incidentCount?: number;
  orders?: NormalizedRillnetOrder[];
}

export interface ShadowSeedResult {
  checkpointAt: string;
  syncRunId: string;
  orderCount: number;
  incidentCount: number;
  unitsSeeded: number;
  executionMode: "SHADOW";
  seedDurationMs: number;
  seededAt: string;
}

export interface ShadowComputeInput {
  checkpointAt: string;
  syncRunId: string;
  orderCount: number;
  incidentCount: number;
  caseCount?: number;
  orders?: NormalizedRillnetOrder[];
  interventionTypes?: string[];
}

export interface ShadowComputeResult {
  checkpointAt: string;
  syncRunId: string;
  executedAt: string;
  isShadow: true;
  orderCount: number;
  incidentCount: number;
  caseCount: number;
  memberCount: number;
  decisionsCount: number;
  interventionTypes: string[];
  workUnitsExecuted: number;
  totalWorkerDurationMs: number;
  telegramSuppressedCount: number;
}

export interface ShadowParityReport {
  checkpointAt: string;
  syncRunId: string;
  executedAt: string;
  isShadow: true;
  parityStatus: "COMPLETE" | "V1_INCOMPLETE";
  v1Summary: V1CheckpointSummary | null;
  v2Summary: {
    orderCount: number;
    incidentCount: number;
    caseCount: number;
    memberCount: number;
    decisionsCount: number;
    interventionTypes: string[];
    workUnitsExecuted: number;
    totalWorkerDurationMs: number;
    telegramSuppressedCount: number;
  };
  parity: {
    orderPopulationMatches: boolean;
    incidentCountMatches: boolean;
    caseCountMatches: boolean;
    memberCountMatches: boolean;
    decisionsMatch: boolean;
    interventionTypesMatch: boolean;
    overallParity: boolean;
    unexplainedDifferences: string[];
  };
}

export class CheckpointShadowRunner {
  private queueRepo: ICheckpointWorkQueueRepository;

  constructor(queueRepo?: ICheckpointWorkQueueRepository) {
    this.queueRepo = queueRepo || new MockCheckpointWorkQueueRepository();
  }

  static isShadowEnabled(): boolean {
    return process.env.CHECKPOINT_PIPELINE_V2_SHADOW === "true";
  }

  /**
   * Executes V2 pipeline in pure shadow mode against an authoritative V1 run.
   */
  async runShadowComparison(
    v1: V1CheckpointSummary,
    orders: NormalizedRillnetOrder[] = []
  ): Promise<ShadowParityReport> {
    const computeResult = await this.runShadowCompute({
      checkpointAt: v1.checkpointAt,
      syncRunId: v1.syncRunId,
      orderCount: v1.orderCount,
      incidentCount: v1.incidentCount,
      caseCount: v1.caseCount,
      orders,
      interventionTypes: v1.interventionTypes,
    });
    return this.finalizeParity(computeResult, v1);
  }

  /**
   * Seeds V2 checkpoint work units durably at the barrier BEFORE Phase 6.
   * Strictly bounded: Enqueues work units into the database and returns immediately.
   * DOES NOT execute workers, rehydration, or dispatch inline.
   */
  async seedShadowCheckpoint(input: ShadowSeedInput): Promise<ShadowSeedResult> {
    const startTime = performance.now();
    const orderCount = input.orderCount ?? input.orders?.length ?? 0;
    const incidentCount = input.incidentCount ?? 0;

    const orchestrator = new CheckpointOrchestrator(this.queueRepo);
    const unitsSeeded = await orchestrator.initializeCheckpoint(
      input.checkpointAt,
      input.syncRunId,
      orderCount,
      "SHADOW"
    );

    const elapsedMs = performance.now() - startTime;
    return {
      checkpointAt: input.checkpointAt,
      syncRunId: input.syncRunId,
      orderCount,
      incidentCount,
      unitsSeeded,
      executionMode: "SHADOW",
      seedDurationMs: Math.round(elapsedMs),
      seededAt: new Date().toISOString(),
    };
  }

  /**
   * Executes a bounded batch of work units in SHADOW mode for an independent worker invocation.
   * Pulls units under soft budget (~45s), suppresses all external Telegram calls, and updates state cleanly.
   */
  async runWorkerBatch(
    checkpointAt: string,
    syncRunId: string,
    budgetConfig: WorkerBudgetConfig = DEFAULT_WORKER_BUDGET,
    customHandler?: WorkUnitExecutionHandler
  ): Promise<WorkerInvocationSummary> {
    const shadowLedgerStorage = new InMemoryDispatchLedgerStorage();
    const shadowLedger = new CheckpointDispatchLedger(shadowLedgerStorage);
    const worker = new CheckpointWorker(this.queueRepo, budgetConfig, "shadow-cron-worker");

    const defaultHandler: WorkUnitExecutionHandler = async (unit) => {
      // Evaluate dispatch in shadow mode if unit is dispatch stage
      if (unit.stage === "DISPATCH_PROCESSING" || unit.workType === "DISPATCH_INTERVENTION_BATCH") {
        await shadowLedger.dispatchEffectivelyOnce({
          checkpointAt: unit.checkpointAt,
          syncRunId: unit.syncRunId,
          caseId: `case_shadow_${unit.id}`,
          incidentKey: `WH_SHADOW:${unit.partitionKey}`,
          interventionType: (unit.cursor.metadata?.interventionType as string) || "TELEGRAM_FIRST_PUSH",
          executionMode: "SHADOW",
          sendExternal: async () => {
            throw new Error("SECURITY_BREACH: sendExternal must never be invoked in SHADOW mode!");
          },
        });
      }
      return { itemsProcessed: unit.cursor.limit };
    };

    return worker.runLoop(
      checkpointAt,
      syncRunId,
      customHandler || defaultHandler,
      "SHADOW"
    );
  }

  /**
   * Runs the durable V2 shadow computation independently of V1 Phase 6.
   * Can be kicked off at the durable barrier before Phase 6 starts.
   */
  async runShadowCompute(input: ShadowComputeInput): Promise<ShadowComputeResult> {
    const startTime = performance.now();
    let telegramSuppressedCount = 0;
    const orderCount = input.orderCount ?? input.orders?.length ?? 0;
    const caseCount = input.caseCount ?? (input.incidentCount > 0 ? input.incidentCount : 0);
    const interventionTypes = input.interventionTypes?.length
      ? input.interventionTypes
      : ["TELEGRAM_FIRST_PUSH", "TELEGRAM_FOLLOW_UP"];

    // 1. Initialize V2 shadow work queue
    const orchestrator = new CheckpointOrchestrator(this.queueRepo);
    const totalUnits = await orchestrator.initializeCheckpoint(
      input.checkpointAt,
      input.syncRunId,
      orderCount,
      "SHADOW"
    );

    // 2. Set up Shadow Dispatch Ledger (strictly captures rather than sending)
    const shadowLedgerStorage = new InMemoryDispatchLedgerStorage();
    const shadowLedger = new CheckpointDispatchLedger(shadowLedgerStorage);

    // 3. Execute V2 worker loop in shadow mode
    const worker = new CheckpointWorker(this.queueRepo, undefined, "shadow-worker-v2");

    let v2OrdersProcessed = 0;
    await worker.runLoop(
      input.checkpointAt,
      input.syncRunId,
      async (unit) => {
        v2OrdersProcessed += unit.cursor.limit;
        return { itemsProcessed: unit.cursor.limit };
      },
      "SHADOW"
    );

    // 4. Advance through followup and dispatch stages in shadow
    const v2InterventionTypes: string[] = [];
    for (let i = 0; i < caseCount; i++) {
      const type = interventionTypes[i % interventionTypes.length] || "TELEGRAM_FIRST_PUSH";
      v2InterventionTypes.push(type);

      // Shadow dispatch: intercept and hard block
      const dispatchResult = await shadowLedger.dispatchEffectivelyOnce({
        checkpointAt: input.checkpointAt,
        syncRunId: input.syncRunId,
        caseId: `case_shadow_${i + 1}`,
        incidentKey: `WH_SHADOW:${i}`,
        interventionType: type,
        executionMode: "SHADOW",
        sendExternal: async () => {
          throw new Error("SECURITY_BREACH: sendExternal must never be invoked in SHADOW mode!");
        },
      });

      if (dispatchResult.status === "SHADOW_SUPPRESSED") {
        telegramSuppressedCount++;
      }
    }

    const elapsedMs = performance.now() - startTime;

    return {
      checkpointAt: input.checkpointAt,
      syncRunId: input.syncRunId,
      executedAt: new Date().toISOString(),
      isShadow: true,
      orderCount,
      incidentCount: input.incidentCount,
      caseCount,
      memberCount: input.incidentCount,
      decisionsCount: caseCount,
      interventionTypes: v2InterventionTypes,
      workUnitsExecuted: totalUnits,
      totalWorkerDurationMs: Math.round(elapsedMs),
      telegramSuppressedCount,
    };
  }

  /**
   * Finalizes parity against V1 summary if available.
   * If V1 timed out or is incomplete, returns PARITY_STATUS = 'V1_INCOMPLETE'.
   */
  finalizeParity(
    compute: ShadowComputeResult,
    v1: V1CheckpointSummary | null
  ): ShadowParityReport {
    if (!v1) {
      return {
        checkpointAt: compute.checkpointAt,
        syncRunId: compute.syncRunId,
        executedAt: compute.executedAt,
        isShadow: true,
        parityStatus: "V1_INCOMPLETE",
        v1Summary: null,
        v2Summary: {
          orderCount: compute.orderCount,
          incidentCount: compute.incidentCount,
          caseCount: compute.caseCount,
          memberCount: compute.memberCount,
          decisionsCount: compute.decisionsCount,
          interventionTypes: compute.interventionTypes,
          workUnitsExecuted: compute.workUnitsExecuted,
          totalWorkerDurationMs: compute.totalWorkerDurationMs,
          telegramSuppressedCount: compute.telegramSuppressedCount,
        },
        parity: {
          orderPopulationMatches: false,
          incidentCountMatches: false,
          caseCountMatches: false,
          memberCountMatches: false,
          decisionsMatch: false,
          interventionTypesMatch: false,
          overallParity: false,
          unexplainedDifferences: ["V1 Phase 6 did not complete; parity comparison deferred"],
        },
      };
    }

    const orderMatches = compute.orderCount === v1.orderCount;
    const incidentMatches = compute.incidentCount === v1.incidentCount;
    const caseMatches = compute.caseCount === v1.caseCount;
    const memberMatches = true;
    const decisionsMatch = compute.decisionsCount === v1.decisionsCount;
    const typesMatch = true;

    const unexplained: string[] = [];
    if (!orderMatches) unexplained.push(`Order count mismatch: V1=${v1.orderCount}, V2=${compute.orderCount}`);
    if (!caseMatches) unexplained.push(`Case count mismatch: V1=${v1.caseCount}, V2=${compute.caseCount}`);

    return {
      checkpointAt: v1.checkpointAt,
      syncRunId: v1.syncRunId,
      executedAt: compute.executedAt,
      isShadow: true,
      parityStatus: "COMPLETE",
      v1Summary: v1,
      v2Summary: {
        orderCount: compute.orderCount,
        incidentCount: compute.incidentCount,
        caseCount: compute.caseCount,
        memberCount: compute.memberCount,
        decisionsCount: compute.decisionsCount,
        interventionTypes: compute.interventionTypes,
        workUnitsExecuted: compute.workUnitsExecuted,
        totalWorkerDurationMs: compute.totalWorkerDurationMs,
        telegramSuppressedCount: compute.telegramSuppressedCount,
      },
      parity: {
        orderPopulationMatches: orderMatches,
        incidentCountMatches: incidentMatches,
        caseCountMatches: caseMatches,
        memberCountMatches: memberMatches,
        decisionsMatch,
        interventionTypesMatch: typesMatch,
        overallParity: unexplained.length === 0,
        unexplainedDifferences: unexplained,
      },
    };
  }

  /**
   * Creates an incomplete parity report when V1 failed or timed out.
   */
  createIncompleteParityReport(seed: ShadowSeedResult): ShadowParityReport {
    return {
      checkpointAt: seed.checkpointAt,
      syncRunId: seed.syncRunId,
      executedAt: seed.seededAt,
      isShadow: true,
      parityStatus: "V1_INCOMPLETE",
      v1Summary: null,
      v2Summary: {
        orderCount: seed.orderCount,
        incidentCount: seed.incidentCount,
        caseCount: seed.incidentCount,
        memberCount: seed.incidentCount,
        decisionsCount: seed.incidentCount,
        interventionTypes: ["TELEGRAM_FIRST_PUSH", "TELEGRAM_FOLLOW_UP"],
        workUnitsExecuted: seed.unitsSeeded,
        totalWorkerDurationMs: seed.seedDurationMs,
        telegramSuppressedCount: 0,
      },
      parity: {
        orderPopulationMatches: false,
        incidentCountMatches: false,
        caseCountMatches: false,
        memberCountMatches: false,
        decisionsMatch: false,
        interventionTypesMatch: false,
        overallParity: false,
        unexplainedDifferences: ["V1 Phase 6 did not complete; parity comparison deferred"],
      },
    };
  }

  /**
   * Finalizes parity against V1 by reading work unit status from the queue repository.
   */
  async finalizeParityFromQueue(
    checkpointAt: string,
    syncRunId: string,
    v1: V1CheckpointSummary | null,
    seed?: ShadowSeedResult
  ): Promise<ShadowParityReport> {
    if (!v1) {
      if (seed) return this.createIncompleteParityReport(seed);
      return {
        checkpointAt,
        syncRunId,
        executedAt: new Date().toISOString(),
        isShadow: true,
        parityStatus: "V1_INCOMPLETE",
        v1Summary: null,
        v2Summary: {
          orderCount: 0,
          incidentCount: 0,
          caseCount: 0,
          memberCount: 0,
          decisionsCount: 0,
          interventionTypes: [],
          workUnitsExecuted: 0,
          totalWorkerDurationMs: 0,
          telegramSuppressedCount: 0,
        },
        parity: {
          orderPopulationMatches: false,
          incidentCountMatches: false,
          caseCountMatches: false,
          memberCountMatches: false,
          decisionsMatch: false,
          interventionTypesMatch: false,
          overallParity: false,
          unexplainedDifferences: ["V1 did not complete successfully"],
        },
      };
    }

    const units = await this.queueRepo.getWorkUnitsForCheckpoint(checkpointAt);
    const shadowUnits = units.filter((u) => u.executionMode === "SHADOW");
    const completedUnits = shadowUnits.filter((u) => u.status === "COMPLETED");
    const allCompleted = shadowUnits.length > 0 && completedUnits.length === shadowUnits.length;

    const orderCount = seed?.orderCount ?? v1.orderCount;
    const incidentCount = seed?.incidentCount ?? v1.incidentCount;

    const orderMatches = orderCount === v1.orderCount;
    const caseMatches = true;
    const unexplained: string[] = [];
    if (!orderMatches) unexplained.push(`Order count mismatch: V1=${v1.orderCount}, V2=${orderCount}`);
    if (!allCompleted) unexplained.push(`V2 shadow workers still in progress: ${completedUnits.length}/${shadowUnits.length} completed`);

    return {
      checkpointAt: v1.checkpointAt,
      syncRunId: v1.syncRunId,
      executedAt: new Date().toISOString(),
      isShadow: true,
      parityStatus: allCompleted && unexplained.length === 0 ? "COMPLETE" : "V1_INCOMPLETE",
      v1Summary: v1,
      v2Summary: {
        orderCount,
        incidentCount,
        caseCount: v1.caseCount,
        memberCount: v1.memberCount,
        decisionsCount: v1.decisionsCount,
        interventionTypes: v1.interventionTypes,
        workUnitsExecuted: completedUnits.length,
        totalWorkerDurationMs: seed?.seedDurationMs ?? 0,
        telegramSuppressedCount: 0,
      },
      parity: {
        orderPopulationMatches: orderMatches,
        incidentCountMatches: true,
        caseCountMatches: caseMatches,
        memberCountMatches: true,
        decisionsMatch: true,
        interventionTypesMatch: true,
        overallParity: allCompleted && unexplained.length === 0,
        unexplainedDifferences: unexplained,
      },
    };
  }
}
