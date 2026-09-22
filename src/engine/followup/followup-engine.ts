import type { Incident } from "../incident";
import type { IncidentHistoryRow, FollowupCaseRow, FollowupEventRow, FollowupState } from "../../connectors/supabase";
import type {
  FollowupCaseUpsert,
  FollowupEventInsert,
  FollowupCasePageCursor,
  IFollowupRepository,
} from "@/repositories/interfaces/IFollowupRepository";
import { evaluateProgressAssessment } from "./assessment";
import { evaluateNextState } from "./state-machine";
import {
  buildCaseMutation,
  buildEventMutation,
  type ProcessTransitionParams,
} from "./transition";
import { FollowupMessageBuilder, type StructuredFollowupPayload } from "./message-builder";
import { DEFAULT_FOLLOWUP_CONFIG, type FollowupConfig } from "../../config/followup";
import {

  Deduplicator,
  type ActionType,
  type EnqueueActionParams,
} from "../action-queue";
import type { ActionQueueMetrics, IActionQueue } from "../action-queue/IActionQueue";
import { logRuntimeError, logRuntimeMessage, serializedPayloadBytes } from "@/observability/runtimeDiagnostics";
import { logger } from "@/observability/logger";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet";
import { assessOperationalCohort, evidenceFromOrder, checkpointKey, localHour, isFreshRillnetSnapshot, nextCheckpoint, OPERATIONAL_CHECKPOINT_POLICY_VERSION } from "@/domain/operational-learning/checkpoint-policy";

// PostgREST translates one bulk upsert into one PostgreSQL statement.  Cohort
// rows contain their evidence JSON, so an entire checkpoint must not become a
// single, statement-timeout-sized write.  This preserves the same conflict
// target and result set while bounding each database statement.
const FOLLOWUP_CASE_UPSERT_CHUNK_SIZE = 50;
const FOLLOWUP_CASE_READ_PAGE_SIZE = 100;

function formatRillnetStatusSignature(signature: string | null | undefined): string {
  try {
    const pairs = JSON.parse(signature || "[]") as Array<[string, number]>;
    return pairs.map(([status, count]) => `${status}: ${count}`).join(", ") || "không xác định";
  } catch {
    return "không xác định";
  }
}

export interface ProcessedFollowupItem {
  incidentId: string;
  incidentKey: string;
  warehouseName: string;
  reasonName: string;
  oldState: string;
  newState: string;
  progressPercent: number;
  assessment: string;
  payload: StructuredFollowupPayload;
}

export interface FollowupRunMetrics {
  incidents: number;
  caseReads: number;
  caseWrites: number;
  eventWrites: number;
  actions: number;
  durationMs: number;
  status: "success" | "failed";
  operationDurationsMs: {
    caseRead: number;
    caseWrite: number;
    eventWrite: number;
    actionEnqueue: number;
  };
  actionQueueMetrics: ActionQueueMetrics;
}

interface PendingActiveTransition {
  incident: Incident;
  transitionResult: ReturnType<typeof evaluateNextState>;
  payload: StructuredFollowupPayload;
  processParams: ProcessTransitionParams;
  caseMutation: FollowupCaseUpsert;
  action?: EnqueueActionParams;
}

interface MutableFollowupRunMetrics {
  incidents: number;
  caseReads: number;
  caseWrites: number;
  eventWrites: number;
  actions: number;
  operationDurationsMs: FollowupRunMetrics["operationDurationsMs"];
  actionQueueStart: ActionQueueMetrics | null;
}

export class FollowupEngine {
  private currentIncidentCount = 0;
  private lastRunMetrics: FollowupRunMetrics | null = null;

  constructor(
    private followupRepo?: IFollowupRepository | null,
    private actionQueue?: IActionQueue | null
  ) {}

  getLastRunMetrics(): FollowupRunMetrics | null {
    return this.lastRunMetrics;
  }

  /**
   * A FOLLOWING_UP case is normally evidence that Push 1 already happened.
   * The narrow legacy recovery is allowed only after every durable source says
   * no Push 1 was delivered.  An unreadable history is deliberately unsafe.
   */
  private async canRecoverLegacyUnpushedCase(prior: FollowupCaseRow | undefined): Promise<boolean> {
    if (!prior || prior.current_state !== "FOLLOWING_UP" || !this.followupRepo || !this.actionQueue?.getActionsByIncidentId) return false;
    if (prior.last_action_confirmed_at) return false;
    try {
      const [events, actions] = await Promise.all([
        this.followupRepo.getEventsByCaseId(prior.id),
        this.actionQueue.getActionsByIncidentId(prior.incident_id),
      ]);
      if (actions === null) return false;
      const confirmedInEvents = events.some(event => event.event_type === "PUSH_CONFIRMED" || event.new_state === "FIRST_PUSH_SENT");
      const deliveredOrOpenFirstPush = actions.some(action => action.action_type === "FIRST_PUSH" && (
        action.status === "SENT" || action.status === "PENDING" || action.status === "PROCESSING"
        || action.outcome === "DELIVERED" || Boolean(action.provider_message_id)
      ));
      return !confirmedInEvents && !deliveredOrOpenFirstPush;
    } catch {
      return false;
    }
  }

  private async loadOperationalCases(metrics: MutableFollowupRunMetrics): Promise<FollowupCaseRow[]> {
    if (!this.followupRepo) return [];

    const cases: FollowupCaseRow[] = [];
    let cursor: FollowupCasePageCursor | undefined;
    for (;;) {
      metrics.caseReads++;
      const page = await this.timeOperation(metrics, "caseRead", () =>
        this.followupRepo!.getOperationalCasesPage(cursor, FOLLOWUP_CASE_READ_PAGE_SIZE)
      );
      cases.push(...page.cases);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return cases;
  }

  /**
   * Processes all current operational incidents through the Follow-up State Machine.
   * State transitions and escalation decisions are 100% deterministic.
   * NEVER invokes AI directly during sync.
   */
  async processIncidentFollowups(
    incidents: Incident[],
    historyMap: Map<string, IncidentHistoryRow[]> = new Map(),
    config: FollowupConfig = DEFAULT_FOLLOWUP_CONFIG,
    referenceTimeMs: number = Date.now(),
    orders?: NormalizedRillnetOrder[]
  ): Promise<ProcessedFollowupItem[]> {
    this.currentIncidentCount = incidents.length;
    const startedAt = performance.now();
    const metrics: MutableFollowupRunMetrics = {
      incidents: incidents.length,
      caseReads: 0,
      caseWrites: 0,
      eventWrites: 0,
      actions: 0,
      operationDurationsMs: {
        caseRead: 0,
        caseWrite: 0,
        eventWrite: 0,
        actionEnqueue: 0,
      },
      actionQueueStart: this.actionQueue?.getMetricsSnapshot?.() || null,
    };

    try {
      if (orders) {
        const results = await this.processOrderCohorts(incidents, orders, referenceTimeMs, metrics);
        this.publishMetrics(metrics, startedAt, "success");
        return results;
      }
      const results = await this.processIncidentFollowupsInternal(
        incidents,
        historyMap,
        config,
        referenceTimeMs,
        metrics
      );
      this.publishMetrics(metrics, startedAt, "success");
      return results;
    } catch (error) {
      this.publishMetrics(metrics, startedAt, "failed");
      throw error;
    }
  }

  private async processOrderCohorts(incidents: Incident[], orders: NormalizedRillnetOrder[], now: number, metrics: MutableFollowupRunMetrics): Promise<ProcessedFollowupItem[]> {
    const checkpoint = checkpointKey(now);
    if (!checkpoint) return [];
    const isBaseline = localHour(now) === 8;
    // 08h is an immutable baseline checkpoint. It must be persisted even when
    // fetchedAt is the Rillnet snapshot updatedAt. The current successful
    // snapshot is accepted only within the governed freshness window.
    if (!isBaseline && !orders.some(order => isFreshRillnetSnapshot(order.fetchedAt, now))) return [];
    // A failed read must abort; replacing an unavailable baseline would erase old work.
    const existing = await this.loadOperationalCases(metrics);
    const byKey = new Map(existing.map(item => [item.incident_key, item]));
    const membership = new Map(orders.map(order => [order.orderCode, evidenceFromOrder(order)]));
    // Routine operational checkpoints are Rillnet-first. GHN enrichment is
    // deliberately outside this synchronous checkpoint path.
    const observations = membership;
    const work = new Map(incidents.map(incident => [incident.incidentKey, incident]));
    for (const item of existing) {
      if (work.has(item.incident_key) || !item.operational_cohort || item.current_state === "CLOSED") continue;
      const member = item.operational_cohort.members[0];
      work.set(item.incident_key, { incidentId: item.incident_id, incidentKey: item.incident_key,
        warehouseId: member?.warehouseId || "", warehouseName: item.incident_key, reasonCode: "KHO_TON", reasonName: "Theo dõi nhóm đơn cũ",
        status: "monitoring", priorityScore: 0, firstDetectedAt: item.first_detected_at, lastDetectedAt: new Date(now).toISOString(),
        affectedOrderCount: 0, affectedOrders: [], sampleOrderCodes: [], averageAgeHours: null, maximumAgeHours: null, oldestOrderCode: null });
    }
    const results: ProcessedFollowupItem[] = [];
    const mutations: FollowupCaseUpsert[] = [];
    const params: ProcessTransitionParams[] = [];
    const actions: EnqueueActionParams[] = [];
    for (const incident of work.values()) {
      const prior = byKey.get(incident.incidentKey);
      if (prior?.operational_cohort?.lastCheckpoint === checkpoint
        && !Object.keys(prior.operational_cohort.verification?.failures || {}).length) continue;
      const codes = new Set([
        ...(prior?.operational_cohort?.members || []).map(member => member.orderCode),
        ...(incident.affectedOrders || []),
      ]);
      const incoming = [...codes].flatMap(code => { const order = membership.get(code); return order ? [order] : []; });
      const assessment = assessOperationalCohort(prior?.operational_cohort, incoming, observations, now);
      const oldState = prior?.current_state || "NEW";
      const mayRecoverLegacyUnpushed = await this.canRecoverLegacyUnpushedCase(prior);
      // A pre-policy 08h baseline was recorded as FOLLOWING_UP without ever
      // requesting Push 1. Recover only when durable action and Event Store
      // history positively show no delivered or open first-push workflow.
      const transitionState: FollowupState = mayRecoverLegacyUnpushed
        ? "NEW"
        : oldState;
      // 08h remains a baseline for every existing ladder stage.  Its sole
      // action exception is a due case entering the first-push workflow.
      const shouldRemind = assessment.reminderCodes.length > 0
        && (!isBaseline || transitionState === "NEW");
      const currentCount = assessment.pending + assessment.unknown;
      const resolved = !isBaseline && assessment.due > 0 && assessment.completed === assessment.due && !assessment.unknown;
      const lastActionAt = prior?.last_action_requested_at ? Date.parse(prior.last_action_requested_at) : NaN;
      const resolvedAt = prior?.resolved_at ? Date.parse(prior.resolved_at) : NaN;
      const timeSinceLastActionHours = Number.isFinite(lastActionAt) ? Math.max(0, (now - lastActionAt) / 3_600_000) : 0;
      const timeSinceResolvedHours = Number.isFinite(resolvedAt) ? Math.max(0, (now - resolvedAt) / 3_600_000) : 0;
      const hasFreshSnapshotAfterLastAction = !Number.isFinite(lastActionAt) || orders.some(order =>
        isFreshRillnetSnapshot(order.fetchedAt, now) && Date.parse(order.fetchedAt) >= lastActionAt
      );
      const notes = `Baseline 8h: ${assessment.baselineDue} đơn đến hạn, ${assessment.baselineProgressed} có tiến triển, ${assessment.baselinePending} chưa hoàn tất. Phát sinh mới đến hạn: ${assessment.newDue}. Tổng đến hạn: ${assessment.due}; hoàn tất chặng: ${assessment.completed}; còn xử lý: ${assessment.pending}; chưa xác minh: ${assessment.unknown}; chưa đến hạn: ${assessment.waiting}. ${isBaseline ? "Snapshot đầu ngày, chưa đánh giá kết quả." : "Tiến triển sau action không chứng minh quan hệ nhân quả."}`;
      // Cohort assessment owns evidence and checkpoint eligibility.  State progression
      // remains exclusively governed by the shared state machine.
      const mustEvaluateTransition = resolved || (!isBaseline && oldState === "RESOLVED") || (oldState === "CLOSED" && currentCount === 0) || shouldRemind;
      const transitionResult: ReturnType<typeof evaluateNextState> = mustEvaluateTransition
        ? evaluateNextState(transitionState, {
          incidentId: incident.incidentId,
          incidentKey: incident.incidentKey,
          currentCount,
          baselineCount: assessment.due,
          previousCount: prior?.latest_affected_order_count || 0,
          countChangePercent: assessment.progressPercent,
          progressPercent: assessment.progressPercent,
          progressAssessment: assessment.assessment,
          incidentDurationHours: Math.max(0, (now - Date.parse(prior?.first_detected_at || incident.firstDetectedAt)) / 3_600_000),
          isIncidentActive: currentCount > 0,
          timeSinceLastActionHours,
          timeSinceResolvedHours,
          hasFreshSnapshotAfterLastAction,
        }, DEFAULT_FOLLOWUP_CONFIG, now)
        : {
          oldState,
          newState: oldState === "NEW" ? "FOLLOWING_UP" : oldState,
          assessment: assessment.assessment,
          eventType: "ASSESSMENT_CHECKED",
          notes,
          nextActionAt: nextCheckpoint(now),
        };
      if (transitionState !== oldState) transitionResult.oldState = oldState;
      const newState = transitionResult.newState;
      assessment.cohort.lastCheckpoint = checkpoint;
      // Only record a reminder marker when this run actually requested an
      // action.  At 08h later-stage candidates are deliberately not sent.
      for (const member of assessment.cohort.members) if (shouldRemind && assessment.reminderCodes.includes(member.orderCode)) {
        member.lastReminderAt = new Date(now).toISOString(); member.lastReminderStatus = member.status;
      }
      const processParams: ProcessTransitionParams = { incidentId: incident.incidentId, incidentKey: incident.incidentKey,
        firstDetectedAt: prior?.first_detected_at || incident.firstDetectedAt, baselineCount: assessment.due,
        latestCount: currentCount, changePercent: assessment.progressPercent,
        assessment: assessment.assessment, transitionResult, referenceTimeMs: now };
      const mutation = buildCaseMutation(processParams);
      mutation.operational_cohort = assessment.cohort;
      if (!resolved) mutation.resolved_at = null;
      mutations.push(mutation); params.push(processParams);
      const payload = FollowupMessageBuilder.buildPayload({ warehouse: incident.warehouseName, reason: incident.reasonName,
        currentCount: processParams.latestCount, baselineCount: assessment.due, previousCount: prior?.latest_affected_order_count || 0,
        progressPercent: assessment.progressPercent, progressAssessment: assessment.assessment, riskScore: incident.priorityScore,
        riskLevel: "medium", rootCauseSummary: notes, state: newState, nextActionAt: transitionResult.nextActionAt || null,
        lastActionRequestedAt: transitionResult.actionRequestedAt || prior?.last_action_requested_at || null,
        lastActionConfirmedAt: prior?.last_action_confirmed_at || null });
      const actionTypeByState: Partial<Record<FollowupState, ActionType>> = {
        FIRST_PUSH_PENDING: "FIRST_PUSH",
        SECOND_PUSH_PENDING: "SECOND_PUSH",
        THIRD_PUSH_PENDING: "THIRD_PUSH",
        ESCALATION_PENDING: "ESCALATION",
      };
      const actionType = actionTypeByState[newState];
      if (this.actionQueue && actionType && transitionResult.actionRequestedAt) {
        actions.push({
          actionType,
          provider: "console",
          targetType: "WAREHOUSE",
          targetId: incident.warehouseId || incident.warehouseName,
          payload: {
            ...payload,
            incidentId: incident.incidentId,
            incidentKey: incident.incidentKey,
            operationalCheckpointVersion: OPERATIONAL_CHECKPOINT_POLICY_VERSION,
            operationalCheckpoint: checkpoint,
          },
          deduplicationKey: Deduplicator.generateKey(incident.incidentKey, actionType, `${OPERATIONAL_CHECKPOINT_POLICY_VERSION}:${checkpoint}`),
          priority: actionType === "ESCALATION" ? "urgent" : "high",
        });
      }
      results.push({ incidentId: incident.incidentId, incidentKey: incident.incidentKey, warehouseName: incident.warehouseName,
        reasonName: incident.reasonName, oldState, newState, progressPercent: assessment.progressPercent, assessment: assessment.assessment, payload });
    }
    if (this.followupRepo && mutations.length) {
      const persisted = await this.persistCases(mutations, metrics);
      const ids = new Map(persisted.map(item => [item.incident_key, item.id]));
      await this.persistEvents(params.map(item => {
        const id = ids.get(item.incidentKey);
        if (!id) throw new Error(`Missing persisted cohort ${item.incidentKey}`);
        return buildEventMutation(item, id);
      }), metrics);
    }
    if (actions.length > 0 && this.actionQueue) {
      metrics.actions += actions.length;
      if (typeof this.actionQueue.enqueueActionBatch === "function") await this.timeOperation(metrics, "actionEnqueue", () => this.actionQueue!.enqueueActionBatch!(actions));
      else for (const action of actions) await this.timeOperation(metrics, "actionEnqueue", () => this.actionQueue!.enqueueAction(action));
    }
    return results;
  }

  private async processIncidentFollowupsInternal(
    incidents: Incident[],
    historyMap: Map<string, IncidentHistoryRow[]>,
    config: FollowupConfig,
    referenceTimeMs: number,
    metrics: MutableFollowupRunMetrics
  ): Promise<ProcessedFollowupItem[]> {
    const results: ProcessedFollowupItem[] = [];
    const incidentKeys = incidents.map((inc) => inc.incidentKey || inc.incidentId);
    let existingCases: FollowupCaseRow[] = [];

    let loadExistingCasesStartedAt: number | null = null;
    if (this.followupRepo && incidentKeys.length > 0) {
      loadExistingCasesStartedAt = this.logSubphaseStart("loadExistingCases");
      try {
        metrics.caseReads++;
        existingCases = await this.timeOperation(metrics, "caseRead", () =>
          this.followupRepo!.getCasesByIncidentKeys(incidentKeys)
        );
      } catch (error) {
        // Preserve the existing fallback when the case lookup is unavailable.
        logRuntimeError("FollowupEngine.loadExistingCases", error);
      }
    }

    if (loadExistingCasesStartedAt !== null) {
      this.logSubphaseEnd("loadExistingCases", loadExistingCasesStartedAt, { caseMutations: 0, events: 0, actions: 0, repositoryCalls: metrics.caseReads, payloadBytes: 0, rowsLoaded: existingCases.length });
    }
    const caseMap = new Map<string, FollowupCaseRow>();
    for (const followupCase of existingCases) {
      caseMap.set(followupCase.incident_key, followupCase);
    }

    const activeKeys = new Set(incidentKeys);
    const pendingTransitions: PendingActiveTransition[] = [];
    const caseMutationsByIncidentId = new Map<string, FollowupCaseUpsert>();

    const evaluateTransitionsStartedAt = this.logSubphaseStart("evaluateTransitions");
    for (const incident of incidents) {
      const incidentKey = incident.incidentKey || incident.incidentId;
      const existingCase = caseMap.get(incidentKey);
      const historyRows = historyMap.get(incident.incidentId) || [];
      const historyCount = historyRows.length + (existingCase ? 1 : 0);
      const baselineCount = existingCase
        ? existingCase.baseline_affected_order_count || incident.affectedOrderCount
        : incident.affectedOrderCount;
      const previousCount = existingCase
        ? existingCase.latest_affected_order_count || incident.affectedOrderCount
        : incident.affectedOrderCount;

      const { countChangePercent, progressPercent, assessment } = evaluateProgressAssessment(
        incident.affectedOrderCount,
        baselineCount,
        historyCount
      );

      const currentState: FollowupState = existingCase ? existingCase.current_state : "NEW";
      let timeSinceLastActionHours = 0;
      if (existingCase && (existingCase.last_action_confirmed_at || existingCase.last_action_requested_at || existingCase.last_checked_at)) {
        const lastTs = new Date(
          existingCase.last_action_confirmed_at || existingCase.last_action_requested_at || existingCase.last_checked_at
        ).getTime();
        timeSinceLastActionHours = Math.max(0, (referenceTimeMs - lastTs) / (1000 * 60 * 60));
      }

      let timeSinceResolvedHours = 0;
      if (existingCase && existingCase.resolved_at) {
        const resolvedTs = new Date(existingCase.resolved_at).getTime();
        timeSinceResolvedHours = Math.max(0, (referenceTimeMs - resolvedTs) / (1000 * 60 * 60));
      }

      const lastActionAt = existingCase?.last_action_confirmed_at || existingCase?.last_action_requested_at;
      const newestSnapshotAt = historyRows.reduce<number>((latest, row) => Math.max(latest, new Date(row.recorded_at).getTime() || 0), 0);
      const newestHistoryRow = historyRows.reduce<IncidentHistoryRow | null>((latest, row) => !latest || new Date(row.recorded_at).getTime() > new Date(latest.recorded_at).getTime() ? row : latest, null);
      const hasFreshSnapshotAfterLastAction = !lastActionAt || newestSnapshotAt > new Date(lastActionAt).getTime();

      const currentRillnetStatusSignature = incident.rillnetStatusSignature || "";
      const actionSignature = existingCase?.last_action_rillnet_status_signature || null;
      const shouldInitializeActionSignature = Boolean(
        existingCase?.last_action_confirmed_at &&
        !actionSignature &&
        currentRillnetStatusSignature
      );
      const shouldPauseForRillnetChange = Boolean(
        existingCase &&
        actionSignature &&
        currentRillnetStatusSignature &&
        actionSignature !== currentRillnetStatusSignature &&
        currentState !== "RILLNET_CHANGE_PAUSED" &&
        currentState !== "RESOLVED" &&
        currentState !== "CLOSED"
      );
      const rillnetChangeSummary = shouldPauseForRillnetChange
        ? `Rillnet status changed after the last reminder (${formatRillnetStatusSignature(actionSignature)} → ${formatRillnetStatusSignature(currentRillnetStatusSignature)}). Automated reminders paused pending manager review.`
        : null;
      const transitionResult: ReturnType<typeof evaluateNextState> = shouldPauseForRillnetChange
        ? {
            oldState: currentState,
            newState: "RILLNET_CHANGE_PAUSED" as FollowupState,
            assessment,
            eventType: "RILLNET_STATUS_CHANGED" as const,
            notes: rillnetChangeSummary || "Rillnet changed status after the last reminder.",
          }
        : evaluateNextState(
        currentState,
        {
          incidentId: incident.incidentId,
          incidentKey,
          currentCount: incident.affectedOrderCount,
          baselineCount,
          previousCount,
          countChangePercent,
          progressPercent,
          progressAssessment: assessment,
          incidentDurationHours: incident.maximumAgeHours || 0,
          isIncidentActive: true,
          timeSinceLastActionHours,
          timeSinceResolvedHours,
          hasFreshSnapshotAfterLastAction,
        },
        config,
          referenceTimeMs
        );

      const processParams: ProcessTransitionParams = {
        incidentId: incident.incidentId,
        incidentKey,
        firstDetectedAt: incident.firstDetectedAt,
        baselineCount,
        latestCount: incident.affectedOrderCount,
        changePercent: progressPercent,
        assessment,
        transitionResult,
        referenceTimeMs,
        currentRillnetStatusSignature,
        lastActionRillnetStatusSignature: shouldInitializeActionSignature ? currentRillnetStatusSignature : undefined,
        rillnetChangeSummary,
        rillnetReviewBeforeSignature: shouldPauseForRillnetChange ? actionSignature || undefined : undefined,
        rillnetReviewAfterSignature: shouldPauseForRillnetChange ? currentRillnetStatusSignature : undefined,
        rillnetReviewSnapshotId: shouldPauseForRillnetChange ? newestHistoryRow?.sync_run_id : undefined,
        rillnetReviewOrderCodes: shouldPauseForRillnetChange ? incident.sampleOrderCodes : undefined,
      };

      const payload = FollowupMessageBuilder.buildPayload({
        warehouse: incident.warehouseName,
        reason: incident.reasonName,
        currentCount: incident.affectedOrderCount,
        baselineCount,
        previousCount,
        progressPercent,
        progressAssessment: assessment,
        riskScore: incident.priorityScore,
        riskLevel: incident.priorityScore >= 75 ? "critical" : incident.priorityScore >= 50 ? "high" : "medium",
        rootCauseSummary: "Theo dõi tồn đọng vận hành.",
        state: transitionResult.newState,
        nextActionAt: transitionResult.nextActionAt || (existingCase ? existingCase.next_action_at : null),
        lastActionRequestedAt:
          transitionResult.actionRequestedAt || (existingCase ? existingCase.last_action_requested_at : null),
        lastActionConfirmedAt:
          transitionResult.actionConfirmedAt || (existingCase ? existingCase.last_action_confirmed_at : null),
      });

      const pending: PendingActiveTransition = {
        incident,
        transitionResult,
        payload,
        processParams,
        caseMutation: buildCaseMutation(processParams),
      };

      if (this.actionQueue && transitionResult.actionRequestedAt !== undefined) {
        let actionType: ActionType = "FIRST_PUSH";
        if (transitionResult.newState === "SECOND_PUSH_PENDING") actionType = "SECOND_PUSH";
        if (transitionResult.newState === "THIRD_PUSH_PENDING") actionType = "THIRD_PUSH";
        if (transitionResult.newState === "ESCALATION_PENDING") actionType = "ESCALATION";

        pending.action = {
          actionType,
          provider: "console",
          targetType: actionType === "ESCALATION" ? "MANAGER" : "WAREHOUSE",
          targetId: incident.warehouseId || incident.warehouseName,
          payload: {
            ...payload,
            incidentId: incident.incidentId,
            incidentKey,
          },
          deduplicationKey: Deduplicator.generateKey(incidentKey, actionType, transitionResult.oldState),
          priority: actionType === "ESCALATION" ? "urgent" : "high",
        };
      }

      pendingTransitions.push(pending);
      caseMutationsByIncidentId.set(incident.incidentId, pending.caseMutation);
    }

    this.logSubphaseEnd("evaluateTransitions", evaluateTransitionsStartedAt, { caseMutations: caseMutationsByIncidentId.size, events: 0, actions: pendingTransitions.filter((pending) => pending.action).length, repositoryCalls: 0 });
    if (this.followupRepo && caseMutationsByIncidentId.size > 0) {
      const persistedCases = await this.persistCases(
        [...caseMutationsByIncidentId.values()],
        metrics
      );
      const caseByIncidentId = new Map(
        persistedCases.map((followupCase) => [followupCase.incident_id, followupCase])
      );
      const activeEvents: FollowupEventInsert[] = pendingTransitions.map((pending) => {
        const persistedCase = caseByIncidentId.get(pending.incident.incidentId);
        if (!persistedCase) {
          throw new Error(
            `Follow-up case upsert returned no row for incident ${pending.incident.incidentId}`
          );
        }
        return buildEventMutation(pending.processParams, persistedCase.id);
      });

      if (activeEvents.length > 0) {
        await this.persistEvents(activeEvents, metrics);
      }
    }

    const enqueueActionsStartedAt = this.logSubphaseStart("enqueueActions");
    try {
      const actionsToEnqueue = pendingTransitions
        .filter((pending) => pending.action)
        .map((pending) => pending.action!);

      if (actionsToEnqueue.length > 0 && this.actionQueue) {
        metrics.actions += actionsToEnqueue.length;
        if (typeof this.actionQueue.enqueueActionBatch === "function") {
          await this.timeOperation(metrics, "actionEnqueue", () =>
            this.actionQueue!.enqueueActionBatch!(actionsToEnqueue)
          );
        } else {
          for (const actionParams of actionsToEnqueue) {
            await this.timeOperation(metrics, "actionEnqueue", () =>
              this.actionQueue!.enqueueAction(actionParams)
            );
          }
        }
      }

      for (const pending of pendingTransitions) {
        results.push({
          incidentId: pending.incident.incidentId,
          incidentKey: pending.processParams.incidentKey,
          warehouseName: pending.incident.warehouseName,
          reasonName: pending.incident.reasonName,
          oldState: pending.transitionResult.oldState,
          newState: pending.transitionResult.newState,
          progressPercent: pending.processParams.changePercent,
          assessment: pending.processParams.assessment,
          payload: pending.payload,
        });
      }

    } catch (error) {
      const failedActionQueueMetrics = this.actionQueue?.getMetricsSnapshot?.();
      const failedActionQueueCalls = metrics.actionQueueStart && failedActionQueueMetrics
        ? (failedActionQueueMetrics.dedupLookups - metrics.actionQueueStart.dedupLookups) +
          (failedActionQueueMetrics.actionInsertCalls - metrics.actionQueueStart.actionInsertCalls) +
          (failedActionQueueMetrics.auditEventWrites - metrics.actionQueueStart.auditEventWrites)
        : 0;
      this.logSubphaseEnd("enqueueActions", enqueueActionsStartedAt, { caseMutations: 0, events: 0, actions: metrics.actions, repositoryCalls: metrics.caseReads + metrics.caseWrites + metrics.eventWrites + failedActionQueueCalls, status: "failed" });
      logRuntimeError("FollowupEngine.enqueueActions", error);
      throw error;
    }
    const actionQueueMetrics = this.actionQueue?.getMetricsSnapshot?.();
    const actionQueueCalls = metrics.actionQueueStart && actionQueueMetrics
      ? (actionQueueMetrics.dedupLookups - metrics.actionQueueStart.dedupLookups) +
        (actionQueueMetrics.actionInsertCalls - metrics.actionQueueStart.actionInsertCalls) +
        (actionQueueMetrics.auditEventWrites - metrics.actionQueueStart.auditEventWrites)
      : 0;
    this.logSubphaseEnd("enqueueActions", enqueueActionsStartedAt, { caseMutations: 0, events: 0, actions: metrics.actions, repositoryCalls: metrics.caseReads + metrics.caseWrites + metrics.eventWrites + actionQueueCalls });
    if (this.followupRepo) {
      await this.processDisappearedCases(activeKeys, config, referenceTimeMs, metrics);
    }

    return results;
  }

  private async persistCases(
    cases: FollowupCaseUpsert[],
    metrics: MutableFollowupRunMetrics
  ): Promise<FollowupCaseRow[]> {
    const startedAt = this.logSubphaseStart("batchUpsertCases");
    const chunks = Array.from(
      { length: Math.ceil(cases.length / FOLLOWUP_CASE_UPSERT_CHUNK_SIZE) },
      (_, index) => cases.slice(index * FOLLOWUP_CASE_UPSERT_CHUNK_SIZE, (index + 1) * FOLLOWUP_CASE_UPSERT_CHUNK_SIZE)
    );
    metrics.caseWrites += chunks.length;
    try {
      const result: FollowupCaseRow[] = [];
      for (const chunk of chunks) {
        result.push(...await this.timeOperation(metrics, "caseWrite", () =>
          this.followupRepo!.batchUpsertCases(chunk)
        ));
      }
      this.logSubphaseEnd("batchUpsertCases", startedAt, {
        caseMutations: cases.length,
        events: 0,
        actions: 0,
        repositoryCalls: chunks.length,
        rowsLoaded: result.length,
        payloadBytes: serializedPayloadBytes(cases),
      });
      return result;
    } catch (error) {
      this.logSubphaseEnd("batchUpsertCases", startedAt, {
        caseMutations: cases.length,
        events: 0,
        actions: 0,
        repositoryCalls: chunks.length,
        rowsLoaded: 0,
        payloadBytes: serializedPayloadBytes(cases),
        status: "failed",
      });
      logRuntimeError("FollowupEngine.batchUpsertCases", error);
      throw error;
    }
  }

  private async persistEvents(
    events: FollowupEventInsert[],
    metrics: MutableFollowupRunMetrics
  ): Promise<FollowupEventRow[]> {
    const startedAt = this.logSubphaseStart("batchInsertEvents");
    metrics.eventWrites++;
    try {
      const result = await this.timeOperation(metrics, "eventWrite", () =>
        this.followupRepo!.batchInsertEvents(events)
      );
      this.logSubphaseEnd("batchInsertEvents", startedAt, {
        caseMutations: 0,
        events: events.length,
        actions: 0,
        repositoryCalls: 1,
        rowsLoaded: result.length,
        payloadBytes: serializedPayloadBytes(events),
      });
      return result;
    } catch (error) {
      this.logSubphaseEnd("batchInsertEvents", startedAt, {
        caseMutations: 0,
        events: events.length,
        actions: 0,
        repositoryCalls: 1,
        rowsLoaded: 0,
        payloadBytes: serializedPayloadBytes(events),
        status: "failed",
      });
      logRuntimeError("FollowupEngine.batchInsertEvents", error);
      throw error;
    }
  }

  private async processDisappearedCases(
    activeKeys: Set<string>,
    config: FollowupConfig,
    referenceTimeMs: number,
    metrics: MutableFollowupRunMetrics
  ): Promise<void> {
    const loadAllCasesStartedAt = this.logSubphaseStart("loadAllCasesForResolution");
    let allCases: FollowupCaseRow[] = [];
    try {
      allCases = await this.loadOperationalCases(metrics);
    } catch (error) {
      // Preserve the existing missing-database/setup fallback.
      this.logSubphaseEnd("loadAllCasesForResolution", loadAllCasesStartedAt, { caseMutations: 0, events: 0, actions: 0, repositoryCalls: metrics.caseReads, rowsLoaded: 0, status: "failed" });
      logRuntimeError("FollowupEngine.loadAllCasesForResolution", error);
      return;
    }

    this.logSubphaseEnd("loadAllCasesForResolution", loadAllCasesStartedAt, { caseMutations: allCases.length, events: 0, actions: 0, repositoryCalls: metrics.caseReads, rowsLoaded: allCases.length });
    const disappearedTransitions: ProcessTransitionParams[] = [];
    for (const followupCase of allCases) {
      if (activeKeys.has(followupCase.incident_key) || followupCase.current_state === "CLOSED") {
        continue;
      }

      let timeSinceResolvedHours = 0;
      if (followupCase.resolved_at) {
        const resolvedTs = new Date(followupCase.resolved_at).getTime();
        timeSinceResolvedHours = Math.max(0, (referenceTimeMs - resolvedTs) / (1000 * 60 * 60));
      }

      const transitionResult = evaluateNextState(
        followupCase.current_state,
        {
          incidentId: followupCase.incident_id,
          incidentKey: followupCase.incident_key,
          currentCount: 0,
          baselineCount: followupCase.baseline_affected_order_count,
          previousCount: followupCase.latest_affected_order_count,
          countChangePercent: -100,
          progressPercent: 100,
          progressAssessment: "strong_progress",
          incidentDurationHours: 0,
          isIncidentActive: false,
          timeSinceLastActionHours: 0,
          timeSinceResolvedHours,
        },
        config,
        referenceTimeMs
      );

      disappearedTransitions.push({
        incidentId: followupCase.incident_id,
        incidentKey: followupCase.incident_key,
        firstDetectedAt: followupCase.first_detected_at,
        baselineCount: followupCase.baseline_affected_order_count,
        latestCount: 0,
        changePercent: 100,
        assessment: "strong_progress",
        transitionResult,
        referenceTimeMs,
      });
    }

    if (disappearedTransitions.length === 0) return;

    try {
      const disappearedCases = await this.persistCases(
        disappearedTransitions.map((transition) => buildCaseMutation(transition)),
        metrics
      );
      const caseByIncidentId = new Map(
        disappearedCases.map((followupCase) => [followupCase.incident_id, followupCase])
      );
      const events = disappearedTransitions.map((transition) => {
        const persistedCase = caseByIncidentId.get(transition.incidentId);
        if (!persistedCase) {
          throw new Error(
            `Follow-up case upsert returned no row for incident ${transition.incidentId}`
          );
        }
        return buildEventMutation(transition, persistedCase.id);
      });
      await this.persistEvents(events, metrics);
    } catch {
      // Preserve the previous behavior: missing-case cleanup errors are suppressed.
    }
  }

  private logSubphaseStart(name: string): number {
    const startedAt = new Date().toISOString();
    logRuntimeMessage("[FollowupRuntime] subphase=" + name + " event=start startedAt=" + startedAt);
    return performance.now();
  }

  private logSubphaseEnd(
    name: string,
    startedAt: number,
    counts: {
      caseMutations: number;
      events: number;
      actions: number;
      repositoryCalls: number;
      payloadBytes?: number;
      rowsLoaded?: number;
      status?: "success" | "failed";
    }
  ): void {
    const finishedAt = new Date().toISOString();
    const durationMs = Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
    logRuntimeMessage(
      "[FollowupRuntime] subphase=" + name +
      " event=end finishedAt=" + finishedAt +
      " durationMs=" + durationMs +
      " incidents=" + this.currentIncidentCount +
      " rowsLoaded=" + (counts.rowsLoaded || 0) +
      " caseMutations=" + counts.caseMutations +
      " events=" + counts.events +
      " actions=" + counts.actions +
      " repositoryCalls=" + counts.repositoryCalls +
      " payloadBytes=" + (counts.payloadBytes || 0) +
      " status=" + (counts.status || "success")
    );
  }

  private async timeOperation<T>(
    metrics: MutableFollowupRunMetrics,
    operation: keyof FollowupRunMetrics["operationDurationsMs"],
    operationCall: () => Promise<T>
  ): Promise<T> {
    const startedAt = performance.now();
    try {
      return await operationCall();
    } finally {
      metrics.operationDurationsMs[operation] += performance.now() - startedAt;
    }
  }

  private publishMetrics(
    metrics: MutableFollowupRunMetrics,
    startedAt: number,
    status: FollowupRunMetrics["status"]
  ): void {
    const actionQueueEnd = this.actionQueue?.getMetricsSnapshot?.() || null;
    const actionQueueMetrics: ActionQueueMetrics = {
      enqueueCalls: (actionQueueEnd?.enqueueCalls || 0) - (metrics.actionQueueStart?.enqueueCalls || 0),
      dedupLookups: (actionQueueEnd?.dedupLookups || 0) - (metrics.actionQueueStart?.dedupLookups || 0),
      actionInsertCalls: (actionQueueEnd?.actionInsertCalls || 0) - (metrics.actionQueueStart?.actionInsertCalls || 0),
      auditEventWrites: (actionQueueEnd?.auditEventWrites || 0) - (metrics.actionQueueStart?.auditEventWrites || 0),
    };
    const published: FollowupRunMetrics = {
      ...metrics,
      actionQueueMetrics,
      durationMs: Number((performance.now() - startedAt).toFixed(3)),
      status,
      operationDurationsMs: {
        caseRead: Number(metrics.operationDurationsMs.caseRead.toFixed(3)),
        caseWrite: Number(metrics.operationDurationsMs.caseWrite.toFixed(3)),
        eventWrite: Number(metrics.operationDurationsMs.eventWrite.toFixed(3)),
        actionEnqueue: Number(metrics.operationDurationsMs.actionEnqueue.toFixed(3)),
      },
    };
    this.lastRunMetrics = published;
    logger.info({
      component: "FollowupEngine",
      operation: "processFollowups",
      status: published.status,
      message: `[FollowupEngine] operation=processFollowups incidents=${published.incidents} caseReads=${published.caseReads} caseWrites=${published.caseWrites} eventWrites=${published.eventWrites} actions=${published.actions} durationMs=${published.durationMs} status=${published.status}`,
      durationMs: published.durationMs,
      metadata: {
        incidents: published.incidents,
        caseReads: published.caseReads,
        caseWrites: published.caseWrites,
        eventWrites: published.eventWrites,
        actions: published.actions,
        operationDurationsMs: published.operationDurationsMs,
      },
    });
  }
}
