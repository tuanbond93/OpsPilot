import { describe, expect, it } from "vitest";
import { apiAccessMessage } from "@/app/_components/apiAccess";
import { buildEdgeSecurityAudit } from "@/security/edge-audit";

describe("access error UX and security audit", () => {
  it("maps authentication and permission failures to Vietnamese operational guidance", () => {
    expect(apiAccessMessage(401)).toContain("đăng nhập");
    expect(apiAccessMessage(403)).toContain("không có quyền");
    expect(apiAccessMessage(500, { message: "Có lỗi" })).toBe("Có lỗi");
  });

  it("builds a bounded audit entry without request body or credentials", () => {
    const entry = buildEdgeSecurityAudit({ event: "PERMISSION_DENIED", path: "/api/debug/sync", method: "POST", correlationId: "corr-1", role: "REVIEWER", subjectId: "user-1", requiredPermission: "MANAGE_SYSTEM" });
    expect(entry).toMatchObject({ category: "SECURITY", event: "PERMISSION_DENIED", role: "REVIEWER" });
    expect(JSON.stringify(entry)).not.toContain("token");
    expect(JSON.stringify(entry)).not.toContain("password");
  });
});
