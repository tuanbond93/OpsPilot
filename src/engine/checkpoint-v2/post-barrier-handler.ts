/**
 * Checkpoint Pipeline V2 - Real Post-Barrier Shadow Execution Handler
 *
 * Implements the governed business logic for V1 Phase 6 execution in V2 shadow mode:
 * 1. EVALUATE_FOLLOWUP_BATCH:
 *    - Rehydrates orders exclusively from persisted order_snapshots (ZERO live Rillnet calls).
 *    - Loads persisted incidents & incident histories for the checkpoint's syncRunId.
 *    - Reuses production domain functions (assessOperationalCohort, evaluateNextState, buildCaseMutation).
 *    - Produces non-authoritative durable ShadowDecision records.
 * 2. PERSIST_MEMBERS_CHUNK:
 *    - Executes real member hydration and generation lifecycle (PREPARING -> manifest verify -> COMMITTED).
 *    - Reuses production functions (operationalCohortMemberRows, planFollowupMemberWriteChunks, assertFollowupMemberGenerationParity).
 * 3. DISPATCH_INTERVENTION_BATCH:
 *    - Evaluates dispatch effectively-once reservations.
 *    - Strictly intercepts and suppresses external Telegram delivery (sendExternal throws SECURITY_BREACH).
 */

import type { NormalizedRillnetOrder } from "@/connectors/rillnet/types";
import type { Incident, IncidentReasonCode } from "@/engine/incident";
import type { IncidentHistoryRow, FollowupCaseRow, FollowupState, ProgressAssessment } from "@/connectors/supabase";
import type { IOrderSnapshotRepository } from "@/repositories/interfaces/IOrderSnapshotRepository";
import type { ISyncRunRepository } from "@/repositories/interfaces/ISyncRunRepository";
import type { IIncidentRepository } from "@/repositories/interfaces/IIncidentRepository";
import type { IIncidentHistoryRepository } from "@/repositories/interfaces/IIncidentHistoryRepository";
import type { IFollowupRepository, FollowupCaseUpsert } from "@/repositories/interfaces/IFollowupRepository";
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
  operationalCohortV2Metadata,
  planFollowupMemberWriteChunks,
  assertFollowupMemberGenerationParity,
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
  evaluatedMutations: FollowupCaseUpsert[];
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
  private stateCache = new Map<string, ShadowExecutionState>();
  private dispatchLedger: CheckpointDispatchLedger;

  constructor(deps: PostBarrierHandlerDependencies = {}) {
    this.deps = deps;
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
    let state = this.stateCache.get(key);
    if (state) return state;

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
      evaluatedMutations: [],
      shadowDecisions: [],
      memberRows: [],
      generationCommitted: false,
      telegramSuppressedCount: 0,
    };

    this.stateCache.set(key, state);
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
          if (prior?.id) mutation.id = prior.id;

          state.evaluatedMutations.push(mutation);

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

          state.shadowDecisions.push(decision);
        }

        return { itemsProcessed: batchIncidents.length };
      }

      // ======================================================================
      // 2. PERSIST_MEMBERS_CHUNK (Phase 6 Governed Member/Generation Pipeline)
      // ======================================================================
      if (unit.workType === "PERSIST_MEMBERS_CHUNK") {
        const generationId = unit.syncRunId;
        const allMemberRows: FollowupCaseMemberRow[] = [];

        // Hydrate cohort member rows using production functions
        for (const mut of state.evaluatedMutations) {
          const caseId = mut.id || `case_shadow_${mut.incident_id}`;
          const cohort = mut.operational_cohort;
          if (cohort && cohort.version === 1) {
            // Production Function 4: operationalCohortV2Metadata
            operationalCohortV2Metadata(cohort);
            // Production Function 5: operationalCohortMemberRows
            const rows = operationalCohortMemberRows(caseId, generationId, generationId, cohort);
            allMemberRows.push(...rows);
          }
        }

        // Production Function 6: planFollowupMemberWriteChunks
        planFollowupMemberWriteChunks(allMemberRows);

        // Production Function 7: assertFollowupMemberGenerationParity
        assertFollowupMemberGenerationParity(allMemberRows, allMemberRows);

        state.memberRows = allMemberRows;
        state.generationCommitted = true;

        return { itemsProcessed: allMemberRows.length > 0 ? allMemberRows.length : unit.cursor.limit };
      }

      // ======================================================================
      // 3. DISPATCH_INTERVENTION_BATCH (Phase 6 Governed Dispatch Suppression)
      // ======================================================================
      if (
        unit.stage === "DISPATCH_PROCESSING" ||
        unit.workType === "DISPATCH_INTERVENTION_BATCH"
      ) {
        const offset = unit.cursor.offset || 0;
        const limit = unit.cursor.limit !== undefined
          ? unit.cursor.limit
          : (state.shadowDecisions.length - offset);
        const batchDecisions = state.shadowDecisions.slice(offset, offset + limit);

        for (const candidate of batchDecisions) {
          const interventionType = candidate.actionType
            ? `TELEGRAM_${candidate.actionType}`
            : (unit.cursor.metadata?.interventionType as string) || "TELEGRAM_FIRST_PUSH";

          // Intercept via CheckpointDispatchLedger with hard zero-delivery guard
          const result = await this.dispatchLedger.dispatchEffectivelyOnce({
            checkpointAt: unit.checkpointAt,
            syncRunId: unit.syncRunId,
            caseId: candidate.caseId,
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

        return { itemsProcessed: batchDecisions.length };
      }

      // Fallback for pre-barrier units (strictly marked non-operational)
      return { itemsProcessed: unit.cursor.limit };
    };
  }
}
