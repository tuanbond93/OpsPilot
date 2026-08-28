import type { FollowupState, TransitionContext, TransitionResult } from "./types";
import { DEFAULT_FOLLOWUP_CONFIG, type FollowupConfig } from "../../config/followup";

/**
 * Evaluates state transitions for an operational follow-up case.
 * 100% deterministic rules:
 * - Progress >= 20% is strong_progress ONLY, NOT resolution.
 * - RESOLVED occurs ONLY when affectedOrderCount === 0 or incident disappears.
 * - PENDING states require explicit confirmation before becoming SENT / ESCALATED.
 */
export function evaluateNextState(
  currentState: FollowupState,
  ctx: TransitionContext,
  config: FollowupConfig = DEFAULT_FOLLOWUP_CONFIG,
  referenceTimeMs: number = Date.now()
): TransitionResult {
  const nowIso = new Date(referenceTimeMs).toISOString();

  // Rule 1: Resolution rule (affectedOrderCount === 0 or incident absent)
  if (!ctx.isIncidentActive || ctx.currentCount === 0) {
    if (currentState === "RESOLVED") {
      if (ctx.timeSinceResolvedHours >= config.closureDelayHours) {
        return {
          oldState: "RESOLVED",
          newState: "CLOSED",
          assessment: ctx.progressAssessment,
          eventType: "CASE_CLOSED",
          notes: `Case closed after ${config.closureDelayHours}h resolution delay without recurrence.`,
        };
      }
      return {
        oldState: "RESOLVED",
        newState: "RESOLVED",
        assessment: ctx.progressAssessment,
        eventType: "ASSESSMENT_CHECKED",
        notes: "Case remains RESOLVED pending closure delay.",
      };
    }

    if (currentState !== "CLOSED") {
      return {
        oldState: currentState,
        newState: "RESOLVED",
        assessment: ctx.progressAssessment,
        eventType: "INCIDENT_RESOLVED",
        notes: "Incident cleared or affected order count reached 0. Case RESOLVED.",
      };
    }

    return {
      oldState: "CLOSED",
      newState: "CLOSED",
      assessment: ctx.progressAssessment,
      eventType: "ASSESSMENT_CHECKED",
      notes: "Case closed.",
    };
  }

  // Rule 2: Recurrence rule (Reopen CLOSED or RESOLVED case if incident reappears with orders)
  if ((currentState === "RESOLVED" || currentState === "CLOSED") && ctx.isIncidentActive && ctx.currentCount > 0) {
    return {
      oldState: currentState,
      newState: "FIRST_PUSH_PENDING",
      assessment: ctx.progressAssessment,
      eventType: "CASE_REOPENED",
      notes: `Incident reappeared with ${ctx.currentCount} affected orders. Case REOPENED.`,
      actionRequestedAt: nowIso,
      nextActionAt: new Date(referenceTimeMs + config.firstReminderDelayHours * 3600 * 1000).toISOString(),
    };
  }

  // Rule 3: NEW case -> Transition to FIRST_PUSH_PENDING
  if (currentState === "NEW") {
    return {
      oldState: "NEW",
      newState: "FIRST_PUSH_PENDING",
      assessment: ctx.progressAssessment,
      eventType: "CASE_CREATED",
      notes: "New incident detected. Initial push requested.",
      actionRequestedAt: nowIso,
      nextActionAt: new Date(referenceTimeMs + config.firstReminderDelayHours * 3600 * 1000).toISOString(),
    };
  }

  // Rule 4: Action Confirmation Handlers
  if (currentState === "FIRST_PUSH_PENDING") {
    if (ctx.isConfirmed) {
      return {
        oldState: "FIRST_PUSH_PENDING",
        newState: "FIRST_PUSH_SENT",
        assessment: ctx.progressAssessment,
        eventType: "PUSH_CONFIRMED",
        notes: `First push notification delivery confirmed by ${ctx.confirmedBy || "system"}.`,
        actionConfirmedAt: nowIso,
        nextActionAt: new Date(referenceTimeMs + config.firstReminderDelayHours * 3600 * 1000).toISOString(),
        confirmedBy: ctx.confirmedBy || "system",
      };
    }
    return {
      oldState: "FIRST_PUSH_PENDING",
      newState: "FIRST_PUSH_PENDING",
      assessment: ctx.progressAssessment,
      eventType: "ASSESSMENT_CHECKED",
      notes: "First push is pending delivery confirmation.",
    };
  }

  if (currentState === "SECOND_PUSH_PENDING") {
    if (ctx.isConfirmed) {
      return {
        oldState: "SECOND_PUSH_PENDING",
        newState: "SECOND_PUSH_SENT",
        assessment: ctx.progressAssessment,
        eventType: "PUSH_CONFIRMED",
        notes: `Second push notification delivery confirmed by ${ctx.confirmedBy || "system"}.`,
        actionConfirmedAt: nowIso,
        nextActionAt: new Date(referenceTimeMs + config.secondReminderDelayHours * 3600 * 1000).toISOString(),
        confirmedBy: ctx.confirmedBy || "system",
      };
    }
    return {
      oldState: "SECOND_PUSH_PENDING",
      newState: "SECOND_PUSH_PENDING",
      assessment: ctx.progressAssessment,
      eventType: "ASSESSMENT_CHECKED",
      notes: "Second push is pending delivery confirmation.",
    };
  }

  if (currentState === "THIRD_PUSH_PENDING") {
    if (ctx.isConfirmed) {
      return {
        oldState: "THIRD_PUSH_PENDING",
        newState: "THIRD_PUSH_SENT",
        assessment: ctx.progressAssessment,
        eventType: "PUSH_CONFIRMED",
        notes: `Third push notification delivery confirmed by ${ctx.confirmedBy || "system"}.`,
        actionConfirmedAt: nowIso,
        nextActionAt: new Date(referenceTimeMs + config.thirdReminderDelayHours * 3600 * 1000).toISOString(),
        confirmedBy: ctx.confirmedBy || "system",
      };
    }
    return {
      oldState: "THIRD_PUSH_PENDING",
      newState: "THIRD_PUSH_PENDING",
      assessment: ctx.progressAssessment,
      eventType: "ASSESSMENT_CHECKED",
      notes: "Third push is pending delivery confirmation.",
    };
  }

  if (currentState === "ESCALATION_PENDING") {
    if (ctx.isConfirmed) {
      return {
        oldState: "ESCALATION_PENDING",
        newState: "ESCALATED",
        assessment: ctx.progressAssessment,
        eventType: "ESCALATION_CONFIRMED",
        notes: `Escalation to Lead & Manager confirmed by ${ctx.confirmedBy || "system"}.`,
        actionConfirmedAt: nowIso,
        confirmedBy: ctx.confirmedBy || "system",
      };
    }
    return {
      oldState: "ESCALATION_PENDING",
      newState: "ESCALATION_PENDING",
      assessment: ctx.progressAssessment,
      eventType: "ASSESSMENT_CHECKED",
      notes: "Escalation is pending manual/system confirmation.",
    };
  }

  // Rule 5: FIRST_PUSH_SENT -> Progress evaluation
  if (currentState === "FIRST_PUSH_SENT") {
    if (ctx.progressAssessment === "strong_progress") {
      return {
        oldState: currentState,
        newState: "FOLLOWING_UP",
        assessment: ctx.progressAssessment,
        eventType: "ASSESSMENT_CHECKED",
        notes: `Strong progress achieved (+${ctx.progressPercent}% reduction). Suppressing second push and continuing follow-up.`,
      };
    }

    if (ctx.hasFreshSnapshotAfterLastAction !== false && ctx.timeSinceLastActionHours >= config.firstReminderDelayHours) {
      return {
        oldState: currentState,
        newState: "SECOND_PUSH_PENDING",
        assessment: ctx.progressAssessment,
        eventType: "PUSH_REQUESTED",
        notes: `Delay threshold of ${config.firstReminderDelayHours}h reached without strong progress. Second push requested.`,
        actionRequestedAt: nowIso,
        nextActionAt: new Date(referenceTimeMs + config.secondReminderDelayHours * 3600 * 1000).toISOString(),
      };
    }
  }

  // Rule 6: FOLLOWING_UP -> Check if progress stalls
  if (currentState === "FOLLOWING_UP") {
    if (ctx.progressAssessment === "strong_progress") {
      return {
        oldState: currentState,
        newState: "FOLLOWING_UP",
        assessment: ctx.progressAssessment,
        eventType: "ASSESSMENT_CHECKED",
        notes: `Strong progress maintained (+${ctx.progressPercent}% reduction). Monitoring continues.`,
      };
    }

    if (ctx.hasFreshSnapshotAfterLastAction !== false && ctx.timeSinceLastActionHours >= config.secondReminderDelayHours) {
      return {
        oldState: currentState,
        newState: "SECOND_PUSH_PENDING",
        assessment: ctx.progressAssessment,
        eventType: "PUSH_REQUESTED",
        notes: `Progress stalled (${ctx.progressAssessment}). Second push requested after ${config.secondReminderDelayHours}h delay.`,
        actionRequestedAt: nowIso,
        nextActionAt: new Date(referenceTimeMs + config.secondReminderDelayHours * 3600 * 1000).toISOString(),
      };
    }
  }

  // Rule 7: SECOND_PUSH_SENT -> third reminder evaluation
  if (currentState === "SECOND_PUSH_SENT") {
    if (ctx.progressAssessment === "strong_progress") {
      return {
        oldState: currentState,
        newState: "FOLLOWING_UP",
        assessment: ctx.progressAssessment,
        eventType: "ASSESSMENT_CHECKED",
        notes: `Strong progress achieved after second push (+${ctx.progressPercent}% reduction). Moving to follow-up monitoring.`,
      };
    }

    if (ctx.hasFreshSnapshotAfterLastAction !== false && ctx.timeSinceLastActionHours >= config.secondReminderDelayHours) {
      return {
        oldState: currentState,
        newState: "THIRD_PUSH_PENDING",
        assessment: ctx.progressAssessment,
        eventType: "PUSH_REQUESTED",
        notes: `No material improvement after ${config.secondReminderDelayHours}h and a new snapshot. Third push requested.`,
        actionRequestedAt: nowIso,
        nextActionAt: new Date(referenceTimeMs + config.thirdReminderDelayHours * 3600 * 1000).toISOString(),
      };
    }
  }

  // Rule 8: THIRD_PUSH_SENT -> manager escalation, only after a newer snapshot.
  if (currentState === "THIRD_PUSH_SENT") {
    if (ctx.progressAssessment === "strong_progress") {
      return {
        oldState: currentState,
        newState: "FOLLOWING_UP",
        assessment: ctx.progressAssessment,
        eventType: "ASSESSMENT_CHECKED",
        notes: `Strong progress achieved after third push (+${ctx.progressPercent}% reduction). Continuing follow-up.`,
      };
    }
    if (ctx.hasFreshSnapshotAfterLastAction !== false && ctx.timeSinceLastActionHours >= config.thirdReminderDelayHours) {
      return {
        oldState: currentState,
        newState: "ESCALATION_PENDING",
        assessment: ctx.progressAssessment,
        eventType: "ESCALATION_REQUESTED",
        notes: `No material improvement after the third push and a new snapshot. Manager escalation requested.`,
        actionRequestedAt: nowIso,
      };
    }
  }

  // Rule 9: ESCALATED -> Remain escalated unless strong progress or resolved
  if (currentState === "ESCALATED") {
    if (ctx.progressAssessment === "strong_progress") {
      return {
        oldState: currentState,
        newState: "FOLLOWING_UP",
        assessment: ctx.progressAssessment,
        eventType: "ASSESSMENT_CHECKED",
        notes: `Strong progress achieved (+${ctx.progressPercent}% reduction) after escalation. Returning to follow-up monitoring.`,
      };
    }

    return {
      oldState: "ESCALATED",
      newState: "ESCALATED",
      assessment: ctx.progressAssessment,
      eventType: "ASSESSMENT_CHECKED",
      notes: "Incident remains in ESCALATED state.",
    };
  }

  // Default: Maintain current state
  return {
    oldState: currentState,
    newState: currentState,
    assessment: ctx.progressAssessment,
    eventType: "ASSESSMENT_CHECKED",
    notes: `No state change. Assessment: ${ctx.progressAssessment} (Progress: ${ctx.progressPercent}%).`,
  };
}
