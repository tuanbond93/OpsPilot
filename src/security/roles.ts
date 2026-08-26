export type OpsRole = "OPERATOR" | "REVIEWER" | "MANAGER" | "ADMIN";
export type OpsPermission = "VIEW_SYSTEM" | "VERIFY_INCIDENT" | "REPORT_FEEDBACK" | "MANAGE_FEEDBACK" | "MANAGE_FOLLOWUP" | "REVIEW_COPILOT" | "MANAGE_DECISION" | "RECORD_OUTCOME" | "EXPORT_LEARNING_DATASET" | "MANAGE_SYSTEM";

const permissions: Record<OpsRole, ReadonlySet<OpsPermission>> = {
  OPERATOR: new Set(["VIEW_SYSTEM", "VERIFY_INCIDENT", "REPORT_FEEDBACK"]),
  REVIEWER: new Set(["VIEW_SYSTEM", "VERIFY_INCIDENT", "REPORT_FEEDBACK", "MANAGE_FEEDBACK", "MANAGE_FOLLOWUP", "REVIEW_COPILOT"]),
  MANAGER: new Set(["VIEW_SYSTEM", "VERIFY_INCIDENT", "REPORT_FEEDBACK", "MANAGE_FEEDBACK", "MANAGE_FOLLOWUP", "REVIEW_COPILOT", "MANAGE_DECISION", "RECORD_OUTCOME", "EXPORT_LEARNING_DATASET"]),
  ADMIN: new Set(["VIEW_SYSTEM", "VERIFY_INCIDENT", "REPORT_FEEDBACK", "MANAGE_FEEDBACK", "MANAGE_FOLLOWUP", "REVIEW_COPILOT", "MANAGE_DECISION", "RECORD_OUTCOME", "EXPORT_LEARNING_DATASET", "MANAGE_SYSTEM"]),
};

export function normalizeOpsRole(value: unknown): OpsRole {
  const role = typeof value === "string" ? value.trim().toUpperCase() : "";
  return ["OPERATOR", "REVIEWER", "MANAGER", "ADMIN"].includes(role) ? role as OpsRole : "OPERATOR";
}

export function roleCan(role: OpsRole, permission: OpsPermission) {
  return permissions[role].has(permission);
}

export function roleFromMetadata(appMetadata?: Record<string, unknown> | null, userMetadata?: Record<string, unknown> | null) {
  return normalizeOpsRole(
    appMetadata?.opspilot_role ?? userMetadata?.opspilot_role ?? appMetadata?.role ?? userMetadata?.role,
  );
}
