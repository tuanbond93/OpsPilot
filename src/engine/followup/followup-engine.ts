import type { Incident } from "../incident";
import type { IncidentHistoryRow, FollowupCaseRow, FollowupEventRow, FollowupState } from "../../connectors/supabase";
import type {
  FollowupCaseUpsert,
  FollowupEventInsert,
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
   * Processes all current operational incidents through the Follow-up State Machine.
   * State transitions and escalation decisions are 100% deterministic.
   * NEVER invokes AI directly during sync.
   */
  async processIncidentFollowups(
    incidents: Incident[],
    historyMap: Map<string, IncidentHistoryRow[]> = new Map(),
    config: FollowupConfig = DEFAULT_FOLLOWUP_CONFIG,
    referenceTimeMs: number = Date.now()
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
      const hasFreshSnapshotAfterLastAction = !lastActionAt || newestSnapshotAt > new Date(lastActionAt).getTime();

      const transitionResult = evaluateNextState(
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
    metrics.caseWrites++;
    try {
      const result = await this.timeOperation(metrics, "caseWrite", () =>
        this.followupRepo!.batchUpsertCases(cases)
      );
      this.logSubphaseEnd("batchUpsertCases", startedAt, {
        caseMutations: cases.length,
        events: 0,
        actions: 0,
        repositoryCalls: 1,
        rowsLoaded: result.length,
        payloadBytes: serializedPayloadBytes(cases),
      });
      return result;
    } catch (error) {
      this.logSubphaseEnd("batchUpsertCases", startedAt, {
        caseMutations: cases.length,
        events: 0,
        actions: 0,
        repositoryCalls: 1,
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
      metrics.caseReads++;
      allCases = await this.timeOperation(metrics, "caseRead", () =>
        this.followupRepo!.getAllCases()
      );
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
