/**
 * V2 is a pure shadow decision contract.  It has no repository, queue,
 * notification, or production state dependency.
 */
export type AdaptiveDecisionType = "ACT_NOW" | "WAIT" | "REQUEST_INFORMATION" | "ESCALATE" | "CLOSE";
export type AdaptiveRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type NotificationFatigueState = "NONE" | "LOW" | "ELEVATED" | "HIGH";
export type AdaptiveTarget = "WAREHOUSE_OPERATOR" | "TEAM_LEAD" | "MANAGER" | "NONE";
export type V1Decision = "NONE" | "FIRST_PUSH" | "SECOND_PUSH" | "THIRD_PUSH" | "ESCALATION" | "RESOLVED" | "CLOSED";
export type ShadowComparisonClass = "SAME_ACTION" | "V2_AVOIDS_UNNECESSARY_NOTIFICATION" | "V2_INTERVENES_EARLIER" | "V2_ESCALATES_INSTEAD_OF_REPEAT" | "V2_WAITS_FOR_VALID_PROGRESS" | "V2_REQUESTS_INFORMATION" | "V2_POTENTIAL_MISS" | "UNKNOWN";

export interface InterventionHistoryItem {
  type: "FIRST_INTERVENTION" | "REMINDER" | "ESCALATION";
  at: string;
  confirmed: boolean;
  responseReceived?: boolean;
  producedProgress?: boolean;
  target?: AdaptiveTarget;
}

export interface ValidException {
  reasonCode: string;
  expiresAt: string;
}

export interface OperatorCommitment {
  promisedAt: string;
  receivedAt: string;
  credible: boolean;
}

/** Read-only snapshot supplied by a future reader or fixture. Missing facts stay missing. */
export interface AdaptiveInterventionState {
  caseId: string;
  incidentKey: string;
  observedAt: string;
  issueType?: string;
  resolved: boolean;
  affectedOrderCount?: number;
  previousAffectedOrderCount?: number;
  backlogAgeMinutes?: number;
  slaDeadlineAt?: string;
  driverAssigned?: boolean;
  routeCreated?: boolean;
  deliveryInProgress?: boolean;
  deliveryEtaAt?: string;
  latestActivityAt?: string;
  deliveryFailed?: boolean;
  validException?: ValidException;
  operatorCommitment?: OperatorCommitment;
  interventions?: InterventionHistoryItem[];
  materialEvents?: Array<"BACKLOG_INCREASED" | "BACKLOG_DECREASED" | "DRIVER_ASSIGNED" | "ROUTE_CREATED" | "DELIVERY_STARTED" | "EXCEPTION_CREATED" | "EXCEPTION_EXPIRED" | "COMMITMENT_RECEIVED" | "SLA_RISK_CHANGED" | "ORDER_RESOLVED" | "DELIVERY_FAILED">;
  evidenceComplete?: boolean;
  /** The V1 decision is evidence for comparison only; V2 never executes it. */
  v1Decision?: V1Decision;
}

export interface AdaptivePolicyConfig {
  etaBufferMinutes: number;
  commitmentBufferMinutes: number;
  lowRiskCheckMinutes: number;
  highRiskCheckMinutes: number;
  recentInterventionMinutes: number;
  meaningfulBacklogDecreasePercent: number;
  highRiskSlaMinutes: number;
  criticalRiskSlaMinutes: number;
  fatigueInterventionThreshold: number;
}

export const DEFAULT_ADAPTIVE_POLICY: AdaptivePolicyConfig = {
  etaBufferMinutes: 30,
  commitmentBufferMinutes: 15,
  lowRiskCheckMinutes: 120,
  highRiskCheckMinutes: 30,
  recentInterventionMinutes: 45,
  meaningfulBacklogDecreasePercent: 20,
  highRiskSlaMinutes: 120,
  criticalRiskSlaMinutes: 30,
  fatigueInterventionThreshold: 2,
};

export interface AdaptiveInterventionDecision {
  caseId: string;
  decision: AdaptiveDecisionType;
  target: AdaptiveTarget;
  reasonCode: string;
  humanReason: string;
  riskLevel: AdaptiveRiskLevel;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  decidedAt: string;
  nextCheckAt: string | null;
  requiredBy: string | null;
  evidenceUsed: string[];
  suppressionStatus: "NONE" | "VALID_EXCEPTION" | "EXPIRED_EXCEPTION" | "UNKNOWN";
  previousInterventionCount: number;
  notificationFatigueState: NotificationFatigueState;
  recommendedChannel?: "TELEGRAM" | "EMPLOYEE_INBOX";
  recommendedActionType?: "FIRST_INTERVENTION" | "FOLLOW_UP" | "ESCALATION" | "REQUEST_STATUS";
}

export interface EmployeeTask {
  caseId: string;
  priority: AdaptiveRiskLevel;
  title: string;
  decision: AdaptiveDecisionType;
  instruction: string;
  deadline: string | null;
  reasonSummary: string;
  allowedResponses: Array<"DONE" | "CANNOT_COMPLETE" | "IN_PROGRESS" | "INFORMATION_INCORRECT">;
}

export type ManagerCaseCategory = "NEEDS_ACTION_NOW" | "WAITING_WITH_VALID_PLAN" | "AT_RISK" | "ESCALATION_REQUIRED" | "RESOLVED" | "ANOMALOUS";

export interface AdaptiveShadowComparison {
  caseId: string;
  v1Decision: V1Decision;
  v2Decision: AdaptiveInterventionDecision;
  classification: ShadowComparisonClass;
}
