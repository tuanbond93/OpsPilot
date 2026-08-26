import type { DecisionFollowupSchedule, DecisionRiskLevel } from "./types";

export const DECISION_FOLLOWUP_POLICY_VERSION = "LC04_V1" as const;

const DELAY_MINUTES: Readonly<Record<DecisionRiskLevel, number>> = {
  CRITICAL: 60,
  HIGH: 120,
  MEDIUM: 240,
  LOW: 480,
};

export function followupDelayMinutes(riskLevel: DecisionRiskLevel): number {
  return DELAY_MINUTES[riskLevel];
}

export function buildDecisionFollowupSchedule(input: {
  decisionId: string;
  executionAuditEventId: string;
  riskLevel: DecisionRiskLevel;
  scheduledBy: string;
  idempotencyKey: string;
  executedAt: string;
  scheduleId?: string;
}): DecisionFollowupSchedule {
  const executedAtMs = new Date(input.executedAt).getTime();
  return {
    scheduleId: input.scheduleId || crypto.randomUUID(),
    decisionId: input.decisionId,
    executionAuditEventId: input.executionAuditEventId,
    status: "SCHEDULED",
    checkAt: new Date(executedAtMs + followupDelayMinutes(input.riskLevel) * 60_000).toISOString(),
    policyVersion: DECISION_FOLLOWUP_POLICY_VERSION,
    riskLevelAtSchedule: input.riskLevel,
    scheduledBy: input.scheduledBy,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.executedAt,
  };
}
