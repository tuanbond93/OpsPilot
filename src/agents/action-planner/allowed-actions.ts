import type {
  AllowedRecommendationType,
  AllowedTargetRole,
  BlockedOption,
} from "./schema";

export const ALLOWED_RECOMMENDATION_TYPES: AllowedRecommendationType[] = [
  "PRIORITIZE_OLD_ORDERS",
  "VERIFY_EXCEPTION",
  "REVIEW_ASSIGNMENT",
  "CONTACT_WAREHOUSE",
  "PREPARE_ESCALATION",
  "CONTINUE_MONITORING",
  "NO_ACTION",
];

export const ALLOWED_TARGET_ROLES: AllowedTargetRole[] = [
  "WAREHOUSE_DISPATCHER",
  "OPERATIONS_LEAD",
  "WAREHOUSE_MANAGER",
  "CUSTOMER_SERVICE",
  "LOGISTICS_EXECUTIVE",
];

export interface AllowedActionsContext {
  reasonCode: string;
  followupState?: string | null;
  riskLevel: "low" | "medium" | "high" | "critical";
  evidenceCodes: string[];
  missingData: string[];
  activeExceptionCount?: number;
}

/**
  Determines the list of allowed recommendation types deterministically based on operational context.
 */
export function getAllowedRecommendationTypes(
  ctx: AllowedActionsContext
): AllowedRecommendationType[] {
  const allowed = new Set<AllowedRecommendationType>();

  // Always allow monitoring fallbacks
  allowed.add("CONTINUE_MONITORING");
  allowed.add("NO_ACTION");

  // Reason-code & Exception specific recommendations
  if (
    ctx.reasonCode === "CUSTOMER_APPOINTMENT" ||
    ctx.reasonCode === "CS_RESCHEDULED" ||
    ctx.reasonCode === "MISSING_PACKAGE" ||
    ctx.reasonCode === "MISSING_DOCUMENT" ||
    ctx.reasonCode === "DAMAGED" ||
    (ctx.activeExceptionCount && ctx.activeExceptionCount > 0)
  ) {
    allowed.add("VERIFY_EXCEPTION");
  }

  // Risk & Age based
  if (
    ctx.evidenceCodes.includes("MAXIMUM_AGE_HOURS") ||
    ctx.riskLevel === "high" ||
    ctx.riskLevel === "critical"
  ) {
    allowed.add("PRIORITIZE_OLD_ORDERS");
    allowed.add("CONTACT_WAREHOUSE");
  }

  // Follow-up state and escalation based
  if (
    ctx.followupState === "SECOND_PUSH_SENT" ||
    ctx.followupState === "ESCALATION_PENDING" ||
    ctx.followupState === "ESCALATED" ||
    ctx.riskLevel === "critical"
  ) {
    allowed.add("PREPARE_ESCALATION");
    allowed.add("REVIEW_ASSIGNMENT");
  }

  if (ctx.followupState === "FIRST_PUSH_SENT" || ctx.followupState === "FOLLOWING_UP") {
    allowed.add("CONTACT_WAREHOUSE");
    allowed.add("REVIEW_ASSIGNMENT");
  }

  return ALLOWED_RECOMMENDATION_TYPES.filter((t) => allowed.has(t));
}

/**
  Determines allowed target roles deterministically based on recommendation type, reasonCode, followupState, and riskLevel.
  LOGISTICS_EXECUTIVE is allowed ONLY when:
  - recommendationType is PREPARE_ESCALATION
  - followupState is ESCALATED
  - risk level is critical
  - deterministic executive escalation policy is enabled
 */
export function getAllowedTargetRoles(
  reasonCode: string,
  recommendationType?: AllowedRecommendationType,
  followupState?: string | null,
  riskLevel: "low" | "medium" | "high" | "critical" = "medium",
  executiveEscalationPolicyEnabled: boolean = true
): AllowedTargetRole[] {
  const roles = new Set<AllowedTargetRole>();

  const isEscalating =
    followupState === "ESCALATION_PENDING" ||
    followupState === "ESCALATED" ||
    riskLevel === "critical";

  if (recommendationType) {
    switch (recommendationType) {
      case "PRIORITIZE_OLD_ORDERS":
        roles.add("WAREHOUSE_DISPATCHER");
        break;
      case "VERIFY_EXCEPTION":
        if (
          reasonCode === "CUSTOMER_APPOINTMENT" ||
          reasonCode === "CS_RESCHEDULED" ||
          reasonCode.includes("CUSTOMER")
        ) {
          roles.add("CUSTOMER_SERVICE");
        }
        roles.add("WAREHOUSE_DISPATCHER");
        break;
      case "REVIEW_ASSIGNMENT":
        roles.add("WAREHOUSE_DISPATCHER");
        roles.add("OPERATIONS_LEAD");
        break;
      case "CONTACT_WAREHOUSE":
        roles.add("OPERATIONS_LEAD");
        break;
      case "PREPARE_ESCALATION":
        roles.add("OPERATIONS_LEAD");
        if (isEscalating) {
          roles.add("WAREHOUSE_MANAGER");
        }
        if (
          followupState === "ESCALATED" &&
          riskLevel === "critical" &&
          executiveEscalationPolicyEnabled
        ) {
          roles.add("LOGISTICS_EXECUTIVE");
        }
        break;
      case "CONTINUE_MONITORING":
      case "NO_ACTION":
        roles.add("WAREHOUSE_DISPATCHER");
        roles.add("OPERATIONS_LEAD");
        break;
    }
  } else {
    // Context-level allowed roles
    roles.add("WAREHOUSE_DISPATCHER");
    roles.add("OPERATIONS_LEAD");

    if (
      reasonCode === "CUSTOMER_APPOINTMENT" ||
      reasonCode === "CS_RESCHEDULED" ||
      reasonCode.includes("CUSTOMER")
    ) {
      roles.add("CUSTOMER_SERVICE");
    }

    if (isEscalating) {
      roles.add("WAREHOUSE_MANAGER");
    }

    if (
      followupState === "ESCALATED" &&
      riskLevel === "critical" &&
      executiveEscalationPolicyEnabled
    ) {
      roles.add("LOGISTICS_EXECUTIVE");
    }
  }

  return ALLOWED_TARGET_ROLES.filter((r) => roles.has(r));
}

/**
  Deterministically generates blocked options for unsupported decisions.
 */
export function getBlockedOptions(missingData: string[] = []): BlockedOption[] {
  const blocked: BlockedOption[] = [];

  // Vehicle Reallocation
  blocked.push({
    option: "Điều phối lại phương tiện vận tải (Vehicle Reallocation)",
    status: "not_evaluable",
    reason: "Yêu cầu dữ liệu vị trí GPS real-time và khả năng tải của phương tiện.",
    missingData: ["NO_VEHICLE_GPS_DATA", "NO_VEHICLE_DATA"].filter((m) =>
      missingData.includes(m) || missingData.length === 0
    ),
  });

  // Staffing Increase
  blocked.push({
    option: "Tăng cường nhân sự / ca trực kho (Staffing Increase)",
    status: "not_evaluable",
    reason: "Yêu cầu dữ liệu kế hoạch ca trực và phân công nhân sự kho.",
    missingData: ["NO_STAFFING_DATA"].filter((m) =>
      missingData.includes(m) || missingData.length === 0
    ),
  });

  // Route Reassignment
  blocked.push({
    option: "Thay đổi lộ trình giao hàng (Route Reassignment)",
    status: "not_evaluable",
    reason: "Yêu cầu dữ liệu tuyến đường, khoảng cách và năng lực vận chuyển.",
    missingData: ["NO_ROUTE_CAPACITY_DATA"].filter((m) =>
      missingData.includes(m) || missingData.length === 0
    ),
  });

  // SLA Modification
  blocked.push({
    option: "Thay đổi chỉ tiêu SLA vận hành (SLA Modification)",
    status: "not_evaluable",
    reason: "Chính sách OpsPilot Action Planner không cho phép tự ý sửa đổi chỉ tiêu SLA.",
    missingData: ["POLICY_RESTRICTION"],
  });

  return blocked;
}
