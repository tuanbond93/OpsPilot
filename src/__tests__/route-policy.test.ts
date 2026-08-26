import { describe, expect, it } from "vitest";
import { isProtectedApiPath, isProtectedPagePath, requiredPermissionForDebugMutation, requiresAdminForDebug, safePostLoginPath } from "@/security/route-policy";

describe("route security policy", () => {
  it("protects operational APIs while leaving health and cron to their own policies", () => {
    expect(isProtectedApiPath("/api/dashboard")).toBe(true);
    expect(isProtectedApiPath("/api/debug/actions/1")).toBe(true);
    expect(isProtectedApiPath("/api/system/health")).toBe(false);
    expect(isProtectedApiPath("/api/cron/process-ai-jobs")).toBe(false);
  });

  it("protects operational pages but leaves account and guide reachable", () => {
    expect(isProtectedPagePath("/incidents/abc")).toBe(true);
    expect(isProtectedPagePath("/account")).toBe(false);
    expect(isProtectedPagePath("/guide")).toBe(false);
  });

  it("only accepts local post-login destinations", () => {
    expect(safePostLoginPath("/incidents/abc?tab=evidence")).toBe("/incidents/abc?tab=evidence");
    expect(safePostLoginPath("https://evil.example")).toBe("/dashboard");
    expect(safePostLoginPath("//evil.example")).toBe("/dashboard");
    expect(safePostLoginPath("/account?next=/account")).toBe("/dashboard");
  });

  it("maps debug mutations to the narrowest operational permission", () => {
    expect(requiresAdminForDebug("/api/debug/followups", "GET")).toBe(false);
    expect(requiresAdminForDebug("/api/debug/sync-background", "POST")).toBe(true);
    expect(requiresAdminForDebug("/api/dashboard", "POST")).toBe(false);
    expect(requiredPermissionForDebugMutation("/api/debug/followups/f-1/confirm", "POST")).toBe("MANAGE_FOLLOWUP");
    expect(requiredPermissionForDebugMutation("/api/debug/planner-runs/p-1/review", "POST")).toBe("REVIEW_COPILOT");
    expect(requiredPermissionForDebugMutation("/api/debug/actions/a-1/retry", "POST")).toBe("MANAGE_SYSTEM");
    expect(requiredPermissionForDebugMutation("/api/debug/actions", "GET")).toBeNull();
  });
});
