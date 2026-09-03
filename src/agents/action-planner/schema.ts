export type AllowedRecommendationType =
  | "PRIORITIZE_OLD_ORDERS"
  | "VERIFY_EXCEPTION"
  | "REVIEW_ASSIGNMENT"
  | "CONTACT_WAREHOUSE"
  | "PREPARE_ESCALATION"
  | "CONTINUE_MONITORING"
  | "NO_ACTION";

export type AllowedTargetRole =
  | "WAREHOUSE_DISPATCHER"
  | "OPERATIONS_LEAD"
  | "WAREHOUSE_MANAGER"
  | "CUSTOMER_SERVICE"
  | "LOGISTICS_EXECUTIVE";

export interface PlannerRecommendation {
  id: string;
  type: AllowedRecommendationType;
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
  targetRole: AllowedTargetRole;
  rationale: string;
  evidenceCodes: string[];
  riskImpact: {
    severity: "low" | "medium" | "high" | "critical";
    potentialConsequence: string;
  };
  prerequisiteData: string[];
  manualApprovalRequired: true;
}

export interface PlannerInvestigation {
  id: string;
  priority: "high" | "medium" | "low";
  action: string;
  rationale: string;
  targetDepartment: "WAREHOUSE_OPS" | "TRANSPORT_LOGISTICS" | "CUSTOMER_SERVICE" | "IT_SYSTEMS";
  requiredData: string[];
  safetyCheck: string;
}

export interface BlockedOption {
  option: string;
  status: "not_evaluable";
  reason: string;
  missingData: string[];
}

export interface NextReview {
  source: "FOLLOWUP_POLICY" | "PLANNER_POLICY";
  reviewAt: string;
  reviewAfterMinutes: number;
  rationale: string;
}

export interface ConfidenceFactor {
  code: string;
  contribution: number;
  explanation: string;
}

export interface Confidence {
  score: number;
  level: "high" | "medium" | "low";
  factors: ConfidenceFactor[];
}

export interface RecommendationRejectionDetail {
  recommendationIndex: number;
  code: string;
  reason: string;
}

export interface PlannerResult {
  executiveSummary: string;

  overallPriority: "high" | "medium" | "low";

  recommendations: PlannerRecommendation[];

  investigations: PlannerInvestigation[];

  blockedOptions: BlockedOption[];

  nextReview: NextReview;

  confidence: Confidence;

  limitations: string[];

  /** Structured audit projection. Older persisted runs may not contain it. */
  evidenceList?: Array<{ code: string; statement: string }>;

  /** Structured limitations used to build blocked options. */
  missingData?: string[];

  rejections?: RecommendationRejectionDetail[];

  metadata: {
    provider: string;
    model: string;
    promptVersion: string;
    generatedAt: string;
    operationalEvidence?: {
      warehouseId: string;
      ghnHubId: string;
      sourceFetchedAt: string | null;
    };
  };

  /** Persisted Root Cause provenance consumed by the Level C decision gate. */
  rootCauseSummary?: string;
  rootCause?: Record<string, unknown>;
}

