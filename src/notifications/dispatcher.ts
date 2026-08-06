import type { ActionQueue, NotificationActionRow } from "../engine/action-queue";
import { RetryEngine } from "../engine/action-queue";
import type { NotificationProvider, ProviderHealth } from "./providers/provider";
import { ConsoleProvider } from "./providers/console";
import { TelegramProvider } from "./providers/telegram";
import { NotificationBuilder } from "./builder";
import type { IFollowupRepository } from "@/repositories/interfaces/IFollowupRepository";
import { evaluateNextState } from "../engine/followup";

export interface DispatchSummary {
  claimedCount: number;
  sentCount: number;
  simulatedCount: number;
  failedCount: number;
  retriedCount: number;
}

export class NotificationDispatcher {
  private providers = new Map<string, NotificationProvider>();

  constructor(
    private queue: ActionQueue,
    private followupRepo?: IFollowupRepository | null,
    private workerId: string = "dispatcher-worker-1"
  ) {
    this.registerProvider(new ConsoleProvider());
    this.registerProvider(new TelegramProvider());
  }

  registerProvider(provider: NotificationProvider): void {
    this.providers.set(provider.name().toLowerCase(), provider);
  }

  getProvider(name: string): NotificationProvider {
    return this.providers.get(name.toLowerCase()) || this.providers.get("console") || new ConsoleProvider();
  }

  async getProvidersHealth(): Promise<ProviderHealth[]> {
    const healthList: ProviderHealth[] = [];
    for (const provider of this.providers.values()) {
      try {
        const h = await provider.health();
        healthList.push(h);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        healthList.push({
          name: provider.name(),
          status: "Offline",
          details: `Health check error: ${msg}`,
        });
      }
    }
    return healthList;
  }

  /**
   * Claims and dispatches due pending actions using atomic claim mechanism.
   * Only DELIVERED outcome transitions status to SENT and confirms Follow-up state.
   * SIMULATED outcome transitions status to SIMULATED and NEVER confirms Follow-up delivery.
   */
  async dispatchPendingActions(
    referenceTimeMs: number = Date.now(),
    limit: number = 10
  ): Promise<DispatchSummary> {
    const summary: DispatchSummary = {
      claimedCount: 0,
      sentCount: 0,
      simulatedCount: 0,
      failedCount: 0,
      retriedCount: 0,
    };

    // 1. Atomically claim due actions
    const claimedActions = await this.queue.claimPendingActions(this.workerId, limit, 300000, referenceTimeMs);
    summary.claimedCount = claimedActions.length;

    for (const action of claimedActions) {
      const provider = this.getProvider(action.provider);
      const formattedText = NotificationBuilder.buildMarkdownText(action);

      let result;
      try {
        result = await provider.send(action, formattedText);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result = {
          outcome: "FAILED" as const,
          errorCode: "UNHANDLED_EXCEPTION",
          error: `Unhandled provider exception: ${msg}`,
        };
      }

      if (result.outcome === "DELIVERED") {
        // Real delivery -> Mark SENT, store message ID, trigger Follow-up state confirmation
        summary.sentCount++;
        const nowIso = new Date().toISOString();

        await this.queue.updateActionStatus(action.id, "SENT", {
          processed_at: nowIso,
          provider_message_id: result.providerMessageId || null,
          outcome: "DELIVERED",
          provider_response: result.response || null,
        });

        await this.queue.appendEvent({
          action_id: action.id,
          event_type: "DELIVERY_SUCCEEDED",
          old_status: "PROCESSING",
          new_status: "SENT",
          attempt_number: action.retry_count + 1,
          provider: provider.name(),
          provider_message_id: result.providerMessageId || null,
          metadata: { response: result.response },
        });

        // Confirm Follow-up delivery ONLY on real DELIVERED
        await this.handleFollowupStateConfirmation(action, `${provider.name()}_dispatcher`);
      } else if (result.outcome === "SIMULATED") {
        // Simulation mode -> Mark SIMULATED, store message ID. NEVER confirm Follow-up delivery!
        summary.simulatedCount++;
        const nowIso = new Date().toISOString();

        await this.queue.updateActionStatus(action.id, "SIMULATED", {
          processed_at: nowIso,
          provider_message_id: result.providerMessageId || null,
          outcome: "SIMULATED",
          provider_response: result.response || null,
        });

        await this.queue.appendEvent({
          action_id: action.id,
          event_type: "DELIVERY_SIMULATED",
          old_status: "PROCESSING",
          new_status: "SIMULATED",
          attempt_number: action.retry_count + 1,
          provider: provider.name(),
          provider_message_id: result.providerMessageId || null,
          metadata: { note: "Simulation mode active. Follow-up state unchanged." },
        });
      } else {
        // Failure -> Classify retry
        const nextRetryCount = action.retry_count + 1;
        const statusCode = result.errorCode?.startsWith("HTTP_")
          ? parseInt(result.errorCode.replace("HTTP_", ""), 10)
          : undefined;

        const canRetry = RetryEngine.shouldRetry(
          nextRetryCount,
          statusCode,
          result.errorCode,
          result.error,
          action.max_retry
        );

        if (canRetry) {
          summary.retriedCount++;
          const delayMs = RetryEngine.getNextRetryDelayMs(nextRetryCount, result.retryAfterSeconds);
          const nextScheduledIso = new Date(referenceTimeMs + delayMs).toISOString();

          await this.queue.updateActionStatus(action.id, "PENDING", {
            retry_count: nextRetryCount,
            scheduled_at: nextScheduledIso,
            last_error: result.error || "Transient error",
          });

          await this.queue.appendEvent({
            action_id: action.id,
            event_type: "RETRY_SCHEDULED",
            old_status: "PROCESSING",
            new_status: "PENDING",
            attempt_number: nextRetryCount,
            provider: provider.name(),
            error_code: result.errorCode || "TRANSIENT_ERROR",
            error_message: result.error || null,
            metadata: { retryAfterSeconds: result.retryAfterSeconds, nextScheduledIso },
          });
        } else {
          summary.failedCount++;
          const nowIso = new Date().toISOString();

          await this.queue.updateActionStatus(action.id, "FAILED", {
            retry_count: nextRetryCount,
            processed_at: nowIso,
            outcome: "FAILED",
            last_error: result.error || "Permanent failure",
          });

          await this.queue.appendEvent({
            action_id: action.id,
            event_type: "DELIVERY_FAILED",
            old_status: "PROCESSING",
            new_status: "FAILED",
            attempt_number: nextRetryCount,
            provider: provider.name(),
            error_code: result.errorCode || "PERMANENT_FAILURE",
            error_message: result.error || null,
          });
        }
      }
    }

    return summary;
  }

  async handleFollowupStateConfirmation(action: NotificationActionRow, confirmedBy: string): Promise<void> {
    if (!this.followupRepo) return;
    const payload = action.payload || {};
    const incidentId = String(payload.incidentId || payload.incident_id || "");
    const incidentKey = String(payload.incidentKey || payload.incident_key || "");

    if (!incidentId && !incidentKey) return;

    try {
      const followupCase = await this.followupRepo.getCaseById(incidentId || incidentKey);
      if (!followupCase) return;

      let isConfirmedAction = false;
      const state = followupCase.current_state;

      if (action.action_type === "FIRST_PUSH" && state === "FIRST_PUSH_PENDING") isConfirmedAction = true;
      if (action.action_type === "SECOND_PUSH" && state === "SECOND_PUSH_PENDING") isConfirmedAction = true;
      if (action.action_type === "ESCALATION" && state === "ESCALATION_PENDING") isConfirmedAction = true;

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
        });

        await this.followupRepo.insertEvent({
          followup_case_id: updatedCase.id,
          event_type: transitionResult.eventType,
          event_time: refTimeIso,
          old_state: transitionResult.oldState,
          new_state: transitionResult.newState,
          assessment: followupCase.current_assessment,
          confirmed_by: confirmedBy,
          notes: transitionResult.notes,
        });
      }
    } catch {
      // Suppress state confirmation error
    }
  }
}
