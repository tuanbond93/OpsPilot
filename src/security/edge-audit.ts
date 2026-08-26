export interface EdgeSecurityAuditInput {
  event: "AUTHENTICATION_REQUIRED" | "PERMISSION_DENIED";
  path: string;
  method: string;
  correlationId: string;
  role?: string;
  subjectId?: string;
  requiredPermission?: string;
}

export function buildEdgeSecurityAudit(input: EdgeSecurityAuditInput) {
  return {
    timestamp: new Date().toISOString(), level: "warn", category: "SECURITY", ...input,
  };
}

export function emitEdgeSecurityAudit(input: EdgeSecurityAuditInput) {
  console.warn(JSON.stringify(buildEdgeSecurityAudit(input)));
}
