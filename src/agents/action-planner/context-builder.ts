import createHash from "crypto";
import type {
  IncidentRow,
  IncidentHistoryRow,
  OrderExceptionRow,
  FollowupCaseRow,
  FollowupEventRow,
} from "@/connectors/supabase";
import type { NotificationActionRow } from "../../engine/action-queue";
import type { RootCauseResult } from "../root-cause/schema";
import { buildPlannerEvidence, type EvidenceItem } from "./evidence-builder";
import {
  getAllowedRecommendationTypes,
  getAllowedTargetRoles,
  getBlockedOptions,
} from "./allowed-actions";
import type {
  AllowedRecommendationType,
  AllowedTargetRole,
  BlockedOption,
} from "./schema";

export interface PlannerContext {
  incident: IncidentRow;
  historyRows: IncidentHistoryRow[];
  rootCauseResult?: RootCauseResult | null;
  followupCase?: FollowupCaseRow | null;
  followupEvents?: FollowupEventRow[];
  actionHistory?: NotificationActionRow[];
  activeExceptions?: OrderExceptionRow[];
  
  metrics: {
    durationHours: number;
    currentAffectedCount: number;
    previousAffectedCount: number;
    countChangePercent: number;
    trendAssessment: "improving" | "stagnant" | "worsening" | "insufficient_data";
    riskLevel: "low" | "medium" | "high" | "critical";
    riskScore: number;
  };

  evidenceList: EvidenceItem[];
  allowedEvidenceCodes: string[];
  allowedRecommendationTypes: AllowedRecommendationType[];
  allowedTargetRoles: AllowedTargetRole[];
  missingData: string[];
  blockedOptions: BlockedOption[];
  contextHash: string;
  promptVersion: string;
  plannerPolicyVersion: number;
  rolePolicyVersion: number;
  actionPolicyVersion: number;
}

/**
  Recursively stringifies any JS value into a canonical JSON string with sorted object keys.
 */
export function stringifyCanonical(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(stringifyCanonical).join(",") + "]";
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = keys.map(
    (key) => JSON.stringify(key) + ":" + stringifyCanonical((obj as Record<string, unknown>)[key])
  );
  return "{" + pairs.join(",") + "}";
}

export function computeCanonicalContextHash(
  incident: IncidentRow,
  historyRows: IncidentHistoryRow[] = [],
  rootCauseResult?: RootCauseResult | null,
  followupCase?: FollowupCaseRow | null,
  activeExceptions: OrderExceptionRow[] = [],
  actionHistory: NotificationActionRow[] = [],
  allowedEvidenceCodes: string[] = [],
  allowedRecommendationTypes: AllowedRecommendationType[] = [],
  allowedTargetRoles: AllowedTargetRole[] = [],
  promptVersion: string = 'v1',
  plannerPolicyVersion: string = 'v1',
  rolePolicyVersion: string = 'v1',
  actionPolicyVersion: string = 'v1',
  rootCausePromptVersion: string = 'v1'
): string {
  const latestHistory = historyRows[0];
  let previousCount = latestHistory ? latestHistory.affected_order_count : 0;
  let countChangePercent = 0;
  let trend: "improving" | "stagnant" | "worsening" | "insufficient_data" = "insufficient_data";

  if (historyRows.length >= 2) {
    previousCount = historyRows[1].affected_order_count;
    if (previousCount > 0) {
      countChangePercent = Math.round(
        (((latestHistory ? latestHistory.affected_order_count : 0) - previousCount) / previousCount) * 100
      );
    }
    if (countChangePercent <= -5) trend = "improving";
    else if (countChangePercent >= 5) trend = "worsening";
    else trend = "stagnant";
  }

  const riskScore = rootCauseResult?.risk?.score ?? incident.priority_score ?? 0;
  const riskFactors = (rootCauseResult?.risk?.factors || [])
    .map((f) => ({ code: f.code, contribution: f.contribution }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const rootCauseCausesFingerprint = (rootCauseResult?.causes || [])
    .map((c) => ({
      title: c.title,
      evidenceCodes: [...c.evidenceCodes].sort(),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));

  const exceptionsFingerprint = activeExceptions
    .map((e) => ({
      orderCode: e.order_code,
      reasonCode: e.reason_code,
      expiresAt: e.expires_at || null,
    }))
    .sort((a, b) => a.orderCode.localeCompare(b.orderCode));

  const actionHistoryFingerprint = actionHistory
    .map((a) => ({
      actionType: a.action_type,
      status: a.status,
      outcome: a.outcome || null,
      processedAt: a.processed_at || null,
    }))
    .sort((a, b) => (a.actionType + a.status).localeCompare(b.actionType + b.status));

  const canonicalPayload = {
    incidentId: incident.id,
    incidentKey: incident.incident_key,
    reasonCode: incident.reason_code,
    affectedOrderCount: latestHistory ? latestHistory.affected_order_count : 0,
    averageAgeHours: latestHistory?.average_age_hours ?? null,
    maximumAgeHours: latestHistory?.maximum_age_hours ?? null,
    trend,
    countChangePercent,
    progressPercent: followupCase?.current_progress_percent ?? 0,
    riskScore,
    riskFactors,
    followupState: followupCase?.current_state ?? null,
    nextActionAt: followupCase?.next_action_at ?? null,
    lastConfirmedAction: followupCase?.last_action_confirmed_at ?? null,
    rootCauseEvidenceCodes: [...allowedEvidenceCodes].sort(),
    rootCauseConfidence: rootCauseResult?.confidence ?? null,
    rootCausePromptVersion: rootCauseResult ? rootCausePromptVersion : null,
    rootCauseCauses: rootCauseCausesFingerprint,
    activeExceptions: exceptionsFingerprint,
    actionHistory: actionHistoryFingerprint,
    allowedRecommendationTypes: [...allowedRecommendationTypes].sort(),
    allowedTargetRoles: [...allowedTargetRoles].sort(),
    promptVersion,
    plannerPolicyVersion,
    rolePolicyVersion,
    actionPolicyVersion,
  };

  const canonicalJson = stringifyCanonical(canonicalPayload);
  return createHash.createHash("sha256").update(canonicalJson).digest("hex");
}

export function buildPlannerContext(
  incident: IncidentRow,
  historyRows: IncidentHistoryRow[] = [],
  rootCauseResult?: RootCauseResult | null,
  followupCase?: FollowupCaseRow | null,
  followupEvents: FollowupEventRow[] = [],
  actionHistory: NotificationActionRow[] = [],
  activeExceptions: OrderExceptionRow[] = [],
  referenceTimeMs: number = Date.now(),
  promptVersion: string = 'v1',
  plannerPolicyVersion: number = 1,
  rolePolicyVersion: number = 1,
  actionPolicyVersion: number = 1
): PlannerContext {
  const firstDetectedMs = new Date(incident.first_detected_at).getTime();
  const lastDetectedMs = new Date(incident.last_detected_at).getTime();
  const durationHours = Math.max(0, Math.round(((lastDetectedMs - firstDetectedMs) / 3600000) * 10) / 10);

  const latestHistory = historyRows[0];
  const currentAffectedCount = latestHistory ? latestHistory.affected_order_count : 0;
  let previousAffectedCount = currentAffectedCount;
  let countChangePercent = 0;
  let trendAssessment: "improving" | "stagnant" | "worsening" | "insufficient_data" = "insufficient_data";

  if (historyRows.length >= 2) {
    previousAffectedCount = historyRows[1].affected_order_count;
    if (previousAffectedCount > 0) {
      countChangePercent = Math.round(
        ((currentAffectedCount - previousAffectedCount) / previousAffectedCount) * 100
      );
    }
    if (countChangePercent <= -5) trendAssessment = "improving";
    else if (countChangePercent >= 5) trendAssessment = "worsening";
    else trendAssessment = "stagnant";
  }

  let riskScore = incident.priority_score || 0;
  let riskLevel: "low" | "medium" | "high" | "critical" = "medium";
  if (rootCauseResult && rootCauseResult.risk) {
    riskScore = rootCauseResult.risk.score;
    riskLevel = rootCauseResult.risk.level;
  } else {
    if (riskScore >= 75) riskLevel = "critical";
    else if (riskScore >= 50) riskLevel = "high";
    else if (riskScore >= 25) riskLevel = "medium";
    else riskLevel = "low";
  }

  const { evidenceList, allowedEvidenceCodes, missingData } = buildPlannerEvidence(
    incident,
    historyRows,
    rootCauseResult,
    followupCase,
    activeExceptions
  );

  const followupState = followupCase ? followupCase.current_state : null;
  const allowedRecommendationTypes = getAllowedRecommendationTypes({
    reasonCode: incident.reason_code,
    followupState,
    riskLevel,
    evidenceCodes: allowedEvidenceCodes,
    missingData,
    activeExceptionCount: activeExceptions.length,
  });

  const allowedTargetRoles = getAllowedTargetRoles(
    incident.reason_code,
    undefined,
    followupState,
    riskLevel
  );

  const blockedOptions = getBlockedOptions(missingData);

  const contextHash = computeCanonicalContextHash(
    incident,
    historyRows,
    rootCauseResult,
    followupCase,
    activeExceptions,
    actionHistory,
    allowedEvidenceCodes,
    allowedRecommendationTypes,
    allowedTargetRoles,
    promptVersion,
    plannerPolicyVersion.toString(),
    rolePolicyVersion.toString(),
    actionPolicyVersion.toString()
  );

  return {
    incident,
    historyRows,
    rootCauseResult,
    followupCase,
    followupEvents,
    actionHistory,
    activeExceptions,
    metrics: {
      durationHours,
      currentAffectedCount,
      previousAffectedCount,
      countChangePercent,
      trendAssessment,
      riskLevel,
      riskScore,
    },
    evidenceList,
    allowedEvidenceCodes,
    allowedRecommendationTypes,
    allowedTargetRoles,
    missingData,
    blockedOptions,
    contextHash,
    promptVersion,
    plannerPolicyVersion,
    rolePolicyVersion,
    actionPolicyVersion,
  };
}
