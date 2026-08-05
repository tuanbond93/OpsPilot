import type { FollowupState, ProgressAssessment, FollowupEventType } from "@/connectors/supabase";

export type { FollowupState, ProgressAssessment, FollowupEventType };

export interface FollowupCase {
  id?: string;
  incidentId: string; // UUID FK
  incidentKey: string;
  currentState: FollowupState;
  firstDetectedAt: string;
  lastCheckedAt: string;
  nextActionAt?: string | null;
  lastActionRequestedAt?: string | null;
  lastActionConfirmedAt?: string | null;
  resolvedAt?: string | null;
  closedAt?: string | null;
  baselineAffectedOrderCount: number;
  latestAffectedOrderCount: number;
  currentProgressPercent: number;
  currentAssessment: ProgressAssessment;
}

export interface TransitionContext {
  incidentId: string;
  incidentKey: string;
  currentCount: number;
  baselineCount: number;
  previousCount: number;
  countChangePercent: number;
  progressPercent: number;
  progressAssessment: ProgressAssessment;
  incidentDurationHours: number;
  isIncidentActive: boolean;
  timeSinceLastActionHours: number;
  timeSinceResolvedHours: number;
  isConfirmed?: boolean;
  confirmedBy?: string;
}

export interface TransitionResult {
  oldState: FollowupState;
  newState: FollowupState;
  assessment: ProgressAssessment;
  eventType: FollowupEventType;
  notes: string;
  nextActionAt?: string | null;
  actionRequestedAt?: string | null;
  actionConfirmedAt?: string | null;
  confirmedBy?: string | null;
}
