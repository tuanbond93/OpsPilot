import type { OpsPermission } from "@/security/roles";

const protectedApiPrefixes = [
  "/api/dashboard", "/api/copilot", "/api/decisions", "/api/incidents",
  "/api/pilot-feedback", "/api/pilot-quality", "/api/ai-learning-dataset",
  "/api/system/config", "/api/system/projections", "/api/debug",
] as const;

const protectedPagePrefixes = [
  "/dashboard", "/incidents", "/reviews", "/followups", "/decisions", "/notifications",
  "/pilot-quality", "/pilot-feedback", "/ai-learning", "/copilot", "/planner", "/rootcause", "/operations",
] as const;

function matchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isProtectedApiPath(pathname: string) {
  return protectedApiPrefixes.some((prefix) => matchesPrefix(pathname, prefix));
}

export function isProtectedPagePath(pathname: string) {
  return protectedPagePrefixes.some((prefix) => matchesPrefix(pathname, prefix));
}

export function requiresAdminForDebug(pathname: string, method: string) {
  return requiredPermissionForDebugMutation(pathname, method) === "MANAGE_SYSTEM";
}

export function requiredPermissionForDebugMutation(pathname: string, method: string): OpsPermission | null {
  const normalizedMethod = method.toUpperCase();
  if (!matchesPrefix(pathname, "/api/debug") || normalizedMethod === "GET" || normalizedMethod === "HEAD") return null;
  if (/^\/api\/debug\/followups\/[^/]+\/confirm$/.test(pathname)) return "MANAGE_FOLLOWUP";
  if (/^\/api\/debug\/planner-runs\/[^/]+\/review$/.test(pathname)) return "REVIEW_COPILOT";
  return "MANAGE_SYSTEM";
}

export function safePostLoginPath(value: string | null | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/account")) return "/dashboard";
  return value;
}
