import type { IFollowupService } from "../interfaces/IFollowupService";
import type { IFollowupRepository } from "@/repositories/interfaces/IFollowupRepository";
import type { IActionQueue } from "@/engine/action-queue/IActionQueue";
import type { Incident } from "@/engine/incident";
import type { IncidentHistoryRow } from "@/repositories/interfaces/IIncidentHistoryRepository";
import type { NotificationActionRow } from "@/engine/action-queue";
import type { FollowupConfig } from "@/config/followup";
import { RillnetConnector } from "@/connectors/rillnet";
import { aggregateIncidents } from "@/engine/incident";
import { FollowupEngine, type ProcessedFollowupItem } from "@/engine/followup";
import { evaluateNextState } from "@/engine/followup/state-machine";

export class FollowupService implements IFollowupService {
  constructor(
    private followupRepo: IFollowupRepository | null = null,
    private actionQueue: IActionQueue | null = null
  ) {}

  async getAllCases(): Promise<{ totalCases: number; cases: any[] }> {
    if (this.followupRepo) {
      const cases = await this.followupRepo.getAllCases();
      return {
        totalCases: cases.length,
        cases,
      };
    }

    // Fallback in-memory state engine run
    const connector = new RillnetConnector();
    const snapshotResult = await connector.fetchSnapshot();
    const incidents = aggregateIncidents(snapshotResult.orders);

    const engine = new FollowupEngine(null, null);
    const results = await engine.processIncidentFollowups(incidents);

    return {
      totalCases: results.length,
      cases: results.map((r) => ({
        incident_id: r.incidentId,
        warehouse_name: r.warehouseName,
        reason_name: r.reasonName,
        current_state: r.newState,
        current_progress_percent: r.progressPercent,
        current_assessment: r.assessment,
        payload: r.payload,
      })),
    };
  }

  async getCaseById(id: string): Promise<{ followupCase: any; events: any[] } | null> {
    if (!this.followupRepo) return null;

    const followupCase = await this.followupRepo.getCaseById(id);
    if (!followupCase) return null;

    const events = await this.followupRepo.getEventsByCaseId(followupCase.id);
    return {
      followupCase,
      events,
    };
  }

  async confirmFollowupAction(
    id: string,
    action: string,
    confirmedBy: string = "manual_operator"
  ): Promise<{
    ok: boolean;
    followupCase?: any;
    event?: any;
    error?: string;
    message?: string;
  }> {
    const normalizedAction = String(action || "").toLowerCase().trim();
    const normalizedConfirmedBy = String(confirmedBy || "manual_operator").trim();

    if (!["first_push", "second_push", "third_push", "escalation"].includes(normalizedAction)) {
      return {
        ok: false,
        error: "InvalidAction",
        message: "Action must be one of 'first_push', 'second_push', 'third_push', or 'escalation'.",
      };
    }

    if (!this.followupRepo) {
      return {
        ok: false,
        error: "NotFound",
        message: `Follow-up case '${id}' not found.`,
      };
    }

    const followupCase = await this.followupRepo.getCaseById(id);
    if (!followupCase) {
      return {
        ok: false,
        error: "NotFound",
        message: `Follow-up case '${id}' not found.`,
      };
    }

    const state = followupCase.current_state;
    if (normalizedAction === "first_push" && state !== "FIRST_PUSH_PENDING") {
      return {
        ok: false,
        error: "StateMismatch",
        message: `Cannot confirm 'first_push' when case state is '${state}'. Expected 'FIRST_PUSH_PENDING'.`,
      };
    }

    if (normalizedAction === "second_push" && state !== "SECOND_PUSH_PENDING") {
      return {
        ok: false,
        error: "StateMismatch",
        message: `Cannot confirm 'second_push' when case state is '${state}'. Expected 'SECOND_PUSH_PENDING'.`,
      };
    }

    if (normalizedAction === "third_push" && state !== "THIRD_PUSH_PENDING") {
      return {
        ok: false,
        error: "StateMismatch",
        message: `Cannot confirm 'third_push' when case state is '${state}'. Expected 'THIRD_PUSH_PENDING'.`,
      };
    }

    if (normalizedAction === "escalation" && state !== "ESCALATION_PENDING") {
      return {
        ok: false,
        error: "StateMismatch",
        message: `Cannot confirm 'escalation' when case state is '${state}'. Expected 'ESCALATION_PENDING'.`,
      };
    }

    const transitionResult = evaluateNextState(state, {
      incidentId: followupCase.incident_id,
      incidentKey: followupCase.incident_key,
      currentCount: followupCase.latest_affected_order_count,
      baselineCount: followupCase.baseline_affected_order_count,
      previousCount: followupCase.latest_affected_order_count,
      countChangePercent: -followupCase.current_progress_percent,
      progressPercent: followupCase.current_progress_percent,
      progressAssessment: followupCase.current_assessment,
      incidentDurationHours: 0,
      isIncidentActive: true,
      timeSinceLastActionHours: 0,
      timeSinceResolvedHours: 0,
      isConfirmed: true,
      confirmedBy: normalizedConfirmedBy,
    });

    const refTimeIso = new Date().toISOString();

    const updatedCase = await this.followupRepo.upsertCase({
      incident_id: followupCase.incident_id,
      incident_key: followupCase.incident_key,
      current_state: transitionResult.newState,
      first_detected_at: followupCase.first_detected_at,
      last_checked_at: refTimeIso,
      next_action_at: transitionResult.nextActionAt ?? followupCase.next_action_at,
      last_action_requested_at: followupCase.last_action_requested_at,
      last_action_confirmed_at: refTimeIso,
      baseline_affected_order_count: followupCase.baseline_affected_order_count,
      latest_affected_order_count: followupCase.latest_affected_order_count,
      current_progress_percent: followupCase.current_progress_percent,
      current_assessment: followupCase.current_assessment,
      current_rillnet_status_signature: followupCase.current_rillnet_status_signature || "",
      last_action_rillnet_status_signature: followupCase.current_rillnet_status_signature || null,
    });

    const newEvent = await this.followupRepo.insertEvent({
      followup_case_id: updatedCase.id,
      event_type: transitionResult.eventType,
      event_time: refTimeIso,
      old_state: transitionResult.oldState,
      new_state: transitionResult.newState,
      assessment: followupCase.current_assessment,
      confirmed_by: normalizedConfirmedBy,
      notes: transitionResult.notes,
    });

    return {
      ok: true,
      followupCase: updatedCase,
      event: newEvent,
    };
  }

  async handleFollowupStateConfirmation(
    action: NotificationActionRow,
    confirmedBy: string
  ): Promise<any> {
    if (!this.followupRepo) return null;

    const payload = action.payload || {};
    const incidentId = String(payload.incidentId || payload.incident_id || action.target_id || "");
    const incidentKey = String(payload.incidentKey || payload.incident_key || "");

    let followupCase = null;
    if (incidentId) {
      followupCase = await this.followupRepo.getCaseById(incidentId);
    }
    if (!followupCase && incidentKey) {
      const cases = await this.followupRepo.getCasesByIncidentKeys([incidentKey]);
      followupCase = cases[0] || null;
    }

    if (!followupCase) return null;

    let isConfirmedAction = false;
    const state = followupCase.current_state;

    if (action.action_type === "FIRST_PUSH" && state === "FIRST_PUSH_PENDING") isConfirmedAction = true;
    if (action.action_type === "SECOND_PUSH" && state === "SECOND_PUSH_PENDING") isConfirmedAction = true;
    if (action.action_type === "THIRD_PUSH" && state === "THIRD_PUSH_PENDING") isConfirmedAction = true;
    if (action.action_type === "ESCALATION" && state === "ESCALATION_PENDING") isConfirmedAction = true;

    // Also support direct state evaluation if action payload confirms state
    if (!isConfirmedAction && (state === "FIRST_PUSH_PENDING" || state === "SECOND_PUSH_PENDING" || state === "THIRD_PUSH_PENDING" || state === "ESCALATION_PENDING")) {
      isConfirmedAction = true;
    }

    if (isConfirmedAction) {
      const transitionResult = evaluateNextState(state, {
        incidentId: followupCase.incident_id,
        incidentKey: followupCase.incident_key,
        currentCount: followupCase.latest_affected_order_count,
        baselineCount: followupCase.baseline_affected_order_count,
        previousCount: followupCase.latest_affected_order_count,
        countChangePercent: -followupCase.current_progress_percent,
        progressPercent: followupCase.current_progress_percent,
        progressAssessment: followupCase.current_assessment,
        incidentDurationHours: 0,
        isIncidentActive: true,
        timeSinceLastActionHours: 0,
        timeSinceResolvedHours: 0,
        isConfirmed: true,
        confirmedBy,
      });

      const refTimeIso = new Date().toISOString();

      const updatedCase = await this.followupRepo.upsertCase({
        incident_id: followupCase.incident_id,
        incident_key: followupCase.incident_key,
        current_state: transitionResult.newState,
        first_detected_at: followupCase.first_detected_at,
        last_checked_at: refTimeIso,
        last_action_confirmed_at: refTimeIso,
        baseline_affected_order_count: followupCase.baseline_affected_order_count,
        latest_affected_order_count: followupCase.latest_affected_order_count,
      current_progress_percent: followupCase.current_progress_percent,
      current_assessment: followupCase.current_assessment,
      current_rillnet_status_signature: followupCase.current_rillnet_status_signature || "",
      last_action_rillnet_status_signature: followupCase.current_rillnet_status_signature || null,
      });

      const newEvent = await this.followupRepo.insertEvent({
        followup_case_id: updatedCase.id,
        event_type: transitionResult.eventType,
        event_time: refTimeIso,
        old_state: transitionResult.oldState,
        new_state: transitionResult.newState,
        assessment: followupCase.current_assessment,
        confirmed_by: confirmedBy,
        notes: transitionResult.notes,
      });

      return { followupCase: updatedCase, event: newEvent };
    }

    return null;
  }

  async resumeAfterRillnetChange(
    id: string,
    resumedBy: string = "manager"
  ): Promise<{ ok: boolean; followupCase?: any; event?: any; error?: string; message?: string }> {
    if (!this.followupRepo) return { ok: false, error: "NotFound", message: `Follow-up case '${id}' not found.` };

    const followupCase = await this.followupRepo.getCaseById(id);
    if (!followupCase) return { ok: false, error: "NotFound", message: `Follow-up case '${id}' not found.` };
    if (followupCase.current_state !== "RILLNET_CHANGE_PAUSED") {
      return { ok: false, error: "StateMismatch", message: "Case is not paused because of a Rillnet status change." };
    }

    const now = new Date().toISOString();
    const updatedCase = await this.followupRepo.upsertCase({
      incident_id: followupCase.incident_id,
      incident_key: followupCase.incident_key,
      current_state: "FOLLOWING_UP",
      first_detected_at: followupCase.first_detected_at,
      last_checked_at: now,
      last_action_confirmed_at: now,
      baseline_affected_order_count: followupCase.baseline_affected_order_count,
      latest_affected_order_count: followupCase.latest_affected_order_count,
      current_progress_percent: followupCase.current_progress_percent,
      current_assessment: followupCase.current_assessment,
      current_rillnet_status_signature: followupCase.current_rillnet_status_signature || "",
      last_action_rillnet_status_signature: followupCase.current_rillnet_status_signature || null,
      rillnet_change_summary: null,
    });
    const event = await this.followupRepo.insertEvent({
      followup_case_id: updatedCase.id,
      event_type: "FOLLOWUP_RESUMED",
      event_time: now,
      old_state: "RILLNET_CHANGE_PAUSED",
      new_state: "FOLLOWING_UP",
      assessment: followupCase.current_assessment,
      confirmed_by: resumedBy,
      notes: "Manager resumed monitoring after reviewing the Rillnet status change. No Telegram message was sent.",
    });
    return { ok: true, followupCase: updatedCase, event };
  }

  async processIncidentFollowups(
    incidents: Incident[],
    historyMap: Map<string, IncidentHistoryRow[]> = new Map(),
    config?: FollowupConfig,
    referenceTimeMs?: number
  ): Promise<ProcessedFollowupItem[]> {
    const engine = new FollowupEngine(this.followupRepo, this.actionQueue);
    return engine.processIncidentFollowups(incidents, historyMap, config, referenceTimeMs);
  }

  async runFollowupForIncident(incidentId: string): Promise<any> {
    // Placeholder implementation; in real code would process followup for this incident
    return { incidentId, status: 'followup_triggered' };
  }
}
