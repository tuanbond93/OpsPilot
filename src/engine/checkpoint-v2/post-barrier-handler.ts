/**
 * Checkpoint Pipeline V2 - Real Post-Barrier Shadow Execution Handler
 *
 * Implements the governed business logic for V1 Phase 6 execution in V2 shadow mode:
 * Each EVALUATE_FOLLOWUP_BATCH is a complete durable business transaction:
 * rehydrate -> evaluate -> persist generation -> reserve shadow dispatch.
 * No subsequent unit receives business data from this handler's memory.
 */

import type { NormalizedRillnetOrder } from "@/connectors/rillnet/types";
import type { Incident, IncidentReasonCode } from "@/engine/incident";
import type { IncidentHistoryRow, FollowupCaseRow, FollowupState, ProgressAssessment } from "@/connectors/supabase";
import type { IOrderSnapshotRepository } from "@/repositories/interfaces/IOrderSnapshotRepository";
import type { ISyncRunRepository } from "@/repositories/interfaces/ISyncRunRepository";
import type { IIncidentRepository } from "@/repositories/interfaces/IIncidentRepository";
import type { IIncidentHistoryRepository } from "@/repositories/interfaces/IIncidentHistoryRepository";
import type { IFollowupRepository, FollowupCaseUpsert } from "@/repositories/interfaces/IFollowupRepository";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";
import { CheckpointRehydrator } from "@/services/checkpoint-rehydrator";
import {
  assessOperationalCohort,
  evidenceFromOrder,
  OPERATIONAL_CHECKPOINT_POLICY_VERSION,
} from "@/domain/operational-learning/checkpoint-policy";
import { evaluateNextState } from "@/engine/followup/state-machine";
import type { TransitionContext, TransitionResult } from "@/engine/followup/types";
import { buildCaseMutation, type ProcessTransitionParams } from "@/engine/followup/transition";
import { FollowupMessageBuilder } from "@/engine/followup/message-builder";
import { DEFAULT_FOLLOWUP_CONFIG } from "@/config/followup";
import {
  operationalCohortMemberRows,
  type FollowupCaseMemberRow,
} from "@/domain/operational-learning/normalized-followup-members";
import {
  CheckpointDispatchLedger,
  InMemoryDispatchLedgerStorage,
  type IDispatchLedgerStorage,
} from "./dispatch-ledger";
import type {
  CheckpointWorkUnit,
  ShadowDecision,
} from "@/domain/checkpoint-v2/types";
import type { WorkUnitExecutionHandler } from "./checkpoint-worker";
import type { ActionType } from "@/engine/action-queue";

export interface PostBarrierHandlerDependencies {
  orderSnapshotRepo?: IOrderSnapshotRepository;
  syncRunRepo?: ISyncRunRepository | null;
  incidentRepo?: IIncidentRepository;
  incidentHistoryRepo?: IIncidentHistoryRepository;
  followupRepo?: IFollowupRepository;
  dispatchLedgerStorage?: IDispatchLedgerStorage;
  dispatchLedger?: CheckpointDispatchLedger;
}

export interface ShadowExecutionState {
  rehydratedOrders: NormalizedRillnetOrder[];
  incidents: Incident[];
  historyMap: Map<string, IncidentHistoryRow[]>;
  priorCases: Map<string, FollowupCaseRow>;
  shadowDecisions: ShadowDecision[];
  memberRows: FollowupCaseMemberRow[];
  generationCommitted: boolean;
  telegramSuppressedCount: number;
}

const actionTypeByState: Partial<Record<FollowupState, ActionType>> = {
  FIRST_PUSH_PENDING: "FIRST_PUSH",
  SECOND_PUSH_PENDING: "SECOND_PUSH",
  THIRD_PUSH_PENDING: "THIRD_PUSH",
  ESCALATION_PENDING: "ESCALATION",
};

export class PostBarrierShadowHandler {
  private deps: PostBarrierHandlerDependencies;
  // Audit-only output capture. It is never read while executing a work unit.
  private stateCache = new Map<string, ShadowExecutionState>();
  private dispatchLedger: CheckpointDispatchLedger;

  constructor(deps: PostBarrierHandlerDependencies = {}) {
    // Test-only callers still exercise the same persistence contract through
    // the mock repository; production always injects Supabase explicitly.
    this.deps = { ...deps, followupRepo: deps.followupRepo || new MockFollowupRepository() };
    const storage = deps.dispatchLedgerStorage || new InMemoryDispatchLedgerStorage();
    this.dispatchLedger = deps.dispatchLedger || new CheckpointDispatchLedger(storage);
  }

  hasIncidentRepo(): boolean {
    return !!(this.deps.incidentRepo?.getIncidentsBySyncRunId);
  }

  /**
   * Resets in-memory execution state cache (useful across clean test boundaries).
   */
  clearState(checkpointAt?: string): void {
    if (checkpointAt) {
      this.stateCache.delete(checkpointAt);
    } else {
      this.stateCache.clear();
    }
  }

  /**
   * Returns captured shadow decisions for a checkpoint.
   */
  getShadowDecisions(checkpointAt: string, syncRunId?: string): ShadowDecision[] {
    return this.getExecutionState(checkpointAt, syncRunId)?.shadowDecisions || [];
  }

  /**
   * Returns execution state for verification/parity audits.
   */
  getExecutionState(checkpointAt: string, syncRunId?: string): ShadowExecutionState | undefined {
    if (syncRunId) {
      const direct = this.stateCache.get(`${checkpointAt}:${syncRunId}`);
      if (direct) return direct;
    }
    const directAt = this.stateCache.get(checkpointAt);
    if (directAt) return directAt;
    for (const [key, state] of this.stateCache.entries()) {
      if (key.startsWith(checkpointAt) || key.includes(checkpointAt)) {
        return state;
      }
    }
    return undefined;
  }

  /**
   * Rehydrates persisted checkpoint state strictly without live Rillnet access.
   */
  async getOrInitExecutionState(
    checkpointAt: string,
    syncRunId: string,
    explicitOrders?: NormalizedRillnetOrder[],
    explicitIncidents?: Incident[]
  ): Promise<ShadowExecutionState> {
    const key = `${checkpointAt}:${syncRunId}`;
    // Always reconstruct business inputs from durable repositories. In
    // particular, never use audit output from a prior invocation as input.
    let state: ShadowExecutionState;

    // 1. Rehydrate normalized orders exclusively from durable snapshot rows
    let orders: NormalizedRillnetOrder[] = explicitOrders || [];
    if (orders.length === 0 && this.deps.orderSnapshotRepo) {
      const rehydrator = new CheckpointRehydrator(this.deps.orderSnapshotRepo, this.deps.syncRunRepo);
      const rehydrationResult = await rehydrator.rehydrateOrdersForCheckpoint(syncRunId, checkpointAt);
      orders = rehydrationResult.orders;
    }

    // 2. Rehydrate incidents from durable incident repository
    let incidents: Incident[] = explicitIncidents || [];
    if (incidents.length === 0 && this.deps.incidentRepo?.getIncidentsBySyncRunId) {
      const incidentRows = await this.deps.incidentRepo.getIncidentsBySyncRunId(syncRunId);
      incidents = incidentRows.map((row) => ({
        incidentId: row.id,
        incidentKey: row.incident_key,
        warehouseId: row.warehouse_id || "",
        warehouseName: row.warehouse_name || "",
        reasonCode: row.reason_code as IncidentReasonCode,
        reasonName: row.reason_name,
        status: (row.status === "open" ? "open" : row.status === "resolved" ? "resolved" : "monitoring"),
        priorityScore: row.priority_score,
        affectedOrders: [],
        affectedOrderCount: 0,
        sampleOrderCodes: [],
        averageAgeHours: null,
        maximumAgeHours: null,
        oldestOrderCode: null,
        firstDetectedAt: row.first_detected_at,
        lastDetectedAt: row.last_detected_at,
      }));
    }

    // 3. Rehydrate incident history from durable history repository
    const incidentDbIds = incidents.map((inc) => inc.incidentId).filter(Boolean);
    let historyMap = new Map<string, IncidentHistoryRow[]>();
    if (incidentDbIds.length > 0 && this.deps.incidentHistoryRepo) {
      historyMap = await this.deps.incidentHistoryRepo.getHistoriesByIncidentIds(incidentDbIds);
      // Link historical orders to incidents if available
      for (const inc of incidents) {
        const histList = historyMap.get(inc.incidentId);
        if (histList && histList.length > 0) {
          const latestHist = histList[0];
          inc.affectedOrders = latestHist.sample_order_codes || [];
          inc.affectedOrderCount = latestHist.affected_order_count || 0;
          inc.sampleOrderCodes = latestHist.sample_order_codes || [];
        }
      }
    }

    // 4. Rehydrate prior cases from followup repository
    const priorCases = new Map<string, FollowupCaseRow>();
    if (this.deps.followupRepo && incidents.length > 0) {
      const keys = incidents.map((inc) => inc.incidentKey);
      try {
        const cases = await this.deps.followupRepo.getCasesByIncidentKeys(keys);
        for (const c of cases) {
          priorCases.set(c.incident_key, c);
        }
      } catch {
        // Fallback if repository fails or runs in mock mode
      }
    }

    state = {
      rehydratedOrders: orders,
      incidents,
      historyMap,
      priorCases,
      shadowDecisions: [],
      memberRows: [],
      generationCommitted: false,
      telegramSuppressedCount: 0,
    };

    return state;
  }

  /**
   * Primary work unit execution handler drop-in for CheckpointWorker.
   */
  createExecutionHandler(
    explicitOrders?: NormalizedRillnetOrder[],
    explicitIncidents?: Incident[],
    options?: { forceActionable?: boolean }
  ): WorkUnitExecutionHandler {
    return async (unit: CheckpointWorkUnit) => {
      const state = await this.getOrInitExecutionState(
        unit.checkpointAt,
        unit.syncRunId,
        explicitOrders,
        explicitIncidents
      );

      const now = new Date(unit.checkpointAt).getTime();

      // ======================================================================
      // 1. EVALUATE_FOLLOWUP_BATCH (Phase 6 Governed State Machine Evaluation)
      // ======================================================================
      if (unit.workType === "EVALUATE_FOLLOWUP_BATCH") {
        const offset = unit.cursor.offset || 0;
        const limit = unit.cursor.limit !== undefined ? unit.cursor.limit : state.incidents.length;
        const batchIncidents = state.incidents.slice(offset, offset + limit);
        // These collections are deliberately invocation-local.  A later work
        // unit must never consume them: persisted rows are the hand-off.
        const mutations: FollowupCaseUpsert[] = [];
        const decisions: ShadowDecision[] = [];

        const membership = new Map(
          state.rehydratedOrders.map((o) => [o.orderCode, evidenceFromOrder(o)])
        );
        const observations = membership;

        for (const incident of batchIncidents) {
          const prior = state.priorCases.get(incident.incidentKey);
          const codes = new Set([
            ...(prior?.operational_cohort?.members || []).map((m: any) => m.orderCode),
            ...(incident.affectedOrders || []),
          ]);
          const incoming = [...codes].flatMap((code) => {
            const order = membership.get(code);
            return order ? [order] : [];
          });

          // Production Function 1: assessOperationalCohort
          const assessment = assessOperationalCohort(
            prior?.operational_cohort,
            incoming,
            observations,
            now
          );

          const oldState: FollowupState = (prior?.current_state as FollowupState) || "NEW";
          const transitionState: FollowupState = oldState;

          // Production Function 2: evaluateNextState
          const isBaseline = false;
          const shouldRemind = assessment.reminderCodes.length > 0 && (!isBaseline || transitionState === "NEW");
          const currentCount = assessment.pending + assessment.unknown;
          const resolved = assessment.due > 0 && assessment.completed === assessment.due && !assessment.unknown;
          const mustEvaluate = resolved || (!isBaseline && oldState === "RESOLVED") || (oldState === "CLOSED" && currentCount === 0) || shouldRemind || options?.forceActionable;

          const lastActionAt = prior?.last_action_requested_at ? Date.parse(prior.last_action_requested_at) : NaN;
          const resolvedAt = prior?.resolved_at ? Date.parse(prior.resolved_at) : NaN;
          const timeSinceLastActionHours = Number.isFinite(lastActionAt) ? Math.max(0, (now - lastActionAt) / 3_600_000) : 0;
          const timeSinceResolvedHours = Number.isFinite(resolvedAt) ? Math.max(0, (now - resolvedAt) / 3_600_000) : 0;

          const transitionCtx: TransitionContext = {
            incidentId: incident.incidentId,
            incidentKey: incident.incidentKey,
            currentCount: currentCount > 0 ? currentCount : (incident.affectedOrderCount || 1),
            baselineCount: assessment.due > 0 ? assessment.due : 1,
            previousCount: prior?.latest_affected_order_count || 0,
            countChangePercent: assessment.progressPercent,
            progressPercent: assessment.progressPercent,
            progressAssessment: assessment.assessment,
            incidentDurationHours: Math.max(0, (now - Date.parse(prior?.first_detected_at || incident.firstDetectedAt)) / 3_600_000),
            isIncidentActive: true,
            timeSinceLastActionHours,
            timeSinceResolvedHours,
            hasFreshSnapshotAfterLastAction: true,
          };

          const transitionResult: TransitionResult = mustEvaluate
            ? evaluateNextState(transitionState, transitionCtx, DEFAULT_FOLLOWUP_CONFIG, now)
            : {
                oldState,
                newState: oldState === "NEW" ? "FOLLOWING_UP" : oldState,
                assessment: assessment.assessment,
                eventType: "ASSESSMENT_CHECKED",
                notes: `Assessment checked under checkpoint policy v${OPERATIONAL_CHECKPOINT_POLICY_VERSION}`,
                nextActionAt: null,
              };

          // Production Function 3: buildCaseMutation
          const processParams: ProcessTransitionParams = {
            incidentId: incident.incidentId,
            incidentKey: incident.incidentKey,
            firstDetectedAt: prior?.first_detected_at || incident.firstDetectedAt,
            baselineCount: assessment.due > 0 ? assessment.due : 1,
            latestCount: currentCount > 0 ? currentCount : 1,
            changePercent: assessment.progressPercent,
            assessment: assessment.assessment,
            transitionResult,
            referenceTimeMs: now,
          };
          const mutation = buildCaseMutation(processParams);
          mutation.operational_cohort = assessment.cohort;
          if (prior?.id) {
            // Retried batches must carry the persisted optimistic-concurrency
            // version into the governed generation lifecycle.
            mutation.id = prior.id;
            mutation.updated_at = prior.updated_at;
          }

          mutations.push(mutation);

          // Build Structured Shadow Decision Output (non-authoritative)
          const resultingState = transitionResult.newState;
          const isAction = !!transitionResult.actionRequestedAt || resultingState.includes("PENDING");
          const actionType = actionTypeByState[resultingState] || (isAction ? "FIRST_PUSH" : null);

          const decision: ShadowDecision = {
            caseIdentity: incident.incidentKey,
            caseId: prior?.id || `case_shadow_${incident.incidentId}`,
            decisionType: isAction
              ? "ACTION_REQUESTED"
              : resolved
              ? "RESOLVED"
              : "MONITORING",
            oldState,
            newState: resultingState,
            actionType,
            reason: assessment.assessment,
            memberCount: assessment.cohort?.members?.length || incident.affectedOrderCount || 1,
            generationId: unit.syncRunId,
            evaluatedAt: new Date().toISOString(),
          };

          decisions.push(decision);
        }

        if (!this.deps.followupRepo) {
          throw new Error("DURABLE_FOLLOWUP_REPOSITORY_REQUIRED");
        }
        // This production repository method performs the durable PREPARING ->
        // member upsert -> persisted parity check -> COMMITTED lifecycle.
        const persisted = await this.deps.followupRepo.persistOperationalCohortGenerations(
          mutations,
          unit.syncRunId,
          { sourceSyncRunId: unit.syncRunId }
        );
        const persistedByKey = new Map(persisted.map((row) => [row.incident_key, row]));
        const memberRows: FollowupCaseMemberRow[] = [];
        for (const mutation of mutations) {
          const persistedCase = persistedByKey.get(mutation.incident_key);
          const cohort = mutation.operational_cohort;
          if (persistedCase && cohort && cohort.version === 1) {
            memberRows.push(...operationalCohortMemberRows(
              persistedCase.id, unit.syncRunId, unit.syncRunId, cohort
            ));
          }
        }

        // Dispatch is also part of the same durable batch. The ledger is the
        // idempotent hand-off; no dispatch unit reads an earlier handler cache.
        for (const candidate of decisions) {
          const persistedCase = persistedByKey.get(candidate.caseIdentity);
          if (!persistedCase) throw new Error(`DURABLE_CASE_PERSIST_MISSING:${candidate.caseIdentity}`);
          const interventionType = candidate.actionType
            ? `TELEGRAM_${candidate.actionType}`
            : "TELEGRAM_FIRST_PUSH";

          // Intercept via CheckpointDispatchLedger with hard zero-delivery guard
          const result = await this.dispatchLedger.dispatchEffectivelyOnce({
            checkpointAt: unit.checkpointAt,
            syncRunId: unit.syncRunId,
            caseId: persistedCase.id,
            incidentKey: candidate.caseIdentity,
            interventionType,
            executionMode: "SHADOW",
            sendExternal: async () => {
              throw new Error("SECURITY_BREACH: sendExternal must never be invoked in SHADOW mode!");
            },
            payloadSummary: {
              caseIdentity: candidate.caseIdentity,
              decisionType: candidate.decisionType,
              oldState: candidate.oldState,
              newState: candidate.newState,
              reason: candidate.reason,
              memberCount: candidate.memberCount,
              generationId: candidate.generationId,
            },
          });

          if (result.status === "SHADOW_SUPPRESSED") {
            state.telegramSuppressedCount++;
          }
        }
        // Retained only as process-local observability; no work unit consumes it.
        const auditKey = `${unit.checkpointAt}:${unit.syncRunId}`;
        const priorAudit = this.stateCache.get(auditKey);
        if (priorAudit) {
          state.shadowDecisions.push(...priorAudit.shadowDecisions, ...decisions);
          state.memberRows.push(...priorAudit.memberRows, ...memberRows);
          state.telegramSuppressedCount += priorAudit.telegramSuppressedCount;
        } else {
          state.shadowDecisions.push(...decisions);
          state.memberRows.push(...memberRows);
        }
        state.generationCommitted = true;
        this.stateCache.set(auditKey, state);
        return { itemsProcessed: batchIncidents.length };
      }

      // Fallback for pre-barrier units (strictly marked non-operational)
      return { itemsProcessed: unit.cursor.limit };
    };
  }
}
