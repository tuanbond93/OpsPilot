import { afterEach, describe, expect, it } from "vitest";
import { securityHeaders } from "@/security/security-headers";

afterEach(() => { delete process.env.NEXT_PUBLIC_SUPABASE_URL; });

describe("security headers", () => {
  it("blocks framing and dangerous browser capabilities", () => {
    const headers = securityHeaders(false);
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["permissions-policy"]).toContain("camera=()");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).toContain("object-src 'none'");
  });

  it("allows the configured Supabase origin without exposing credentials", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co/rest/v1";
    const headers = securityHeaders(true);
    expect(headers["content-security-policy"]).toContain("https://project.supabase.co");
    expect(headers["content-security-policy"]).not.toContain("SUPABASE_ANON_KEY");
    expect(headers["strict-transport-security"]).toContain("max-age=31536000");
  });
});
