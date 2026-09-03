import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeApiRequest, consumeRateLimit, normalizeOpsRole, resetRateLimitsForTests, resolveActor, roleCan, roleFromMetadata, validateMutationRequest } from "../security/api-security";

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.AUTH_ENFORCEMENT_ENABLED;
  resetRateLimitsForTests();
});

describe("API security policy", () => {
  it("defaults unknown roles to least privilege", () => {
    expect(normalizeOpsRole("owner")).toBe("OPERATOR");
    expect(roleCan("OPERATOR", "REVIEW_COPILOT")).toBe(false);
    expect(roleCan("REVIEWER", "REVIEW_COPILOT")).toBe(true);
    expect(roleCan("REVIEWER", "MANAGE_FOLLOWUP")).toBe(true);
    expect(roleCan("OPERATOR", "MANAGE_FOLLOWUP")).toBe(false);
    expect(roleCan("MANAGER", "MANAGE_DECISION")).toBe(true);
    expect(roleCan("MANAGER", "MANAGE_SYSTEM")).toBe(false);
    expect(roleCan("ADMIN", "MANAGE_SYSTEM")).toBe(true);
  });

  it("reads the documented opspilot_role metadata before legacy role keys", () => {
    expect(roleFromMetadata({ opspilot_role: "ADMIN", role: "OPERATOR" }, {})).toBe("ADMIN");
    expect(roleFromMetadata({}, { opspilot_role: "REVIEWER" })).toBe("REVIEWER");
    expect(roleFromMetadata({ role: "MANAGER" }, {})).toBe("MANAGER");
  });

  it("ignores a spoofed body actor when a session identity exists", () => {
    expect(resolveActor({ actor: "manager@ops.vn" }, "attacker@evil.vn")).toBe("manager@ops.vn");
    expect(resolveActor(null, " local-operator ")).toBe("local-operator");
  });

  it("enforces bounded rate limits", () => {
    expect(consumeRateLimit("key", 2, 1000, 0).allowed).toBe(true);
    expect(consumeRateLimit("key", 2, 1000, 1).allowed).toBe(true);
    expect(consumeRateLimit("key", 2, 1000, 2).allowed).toBe(false);
    expect(consumeRateLimit("key", 2, 1000, 1001).allowed).toBe(true);
  });

  it("rejects oversized bodies and cross-origin mutations when enforcement is enabled", () => {
    process.env.AUTH_ENFORCEMENT_ENABLED = "true";
    const oversized = { url: "https://ops.example/api", headers: new Headers({ "content-length": "40000" }) };
    expect(validateMutationRequest(oversized).error).toBe("PAYLOAD_TOO_LARGE");
    const crossOrigin = { url: "https://ops.example/api", headers: new Headers({ origin: "https://evil.example" }) };
    expect(validateMutationRequest(crossOrigin).error).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("fails closed in production when auth enforcement is not enabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.AUTH_ENFORCEMENT_ENABLED;
    const request = new NextRequest("https://ops.example/api/cron/followup-cycle");

    const result = await authorizeApiRequest(request, "MANAGE_SYSTEM");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      await expect(result.response.json()).resolves.toEqual({ error: "AUTH_ENFORCEMENT_REQUIRED" });
    }
  });

  it("keeps explicit local test mode available when auth enforcement is disabled", async () => {
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.AUTH_ENFORCEMENT_ENABLED;
    const request = new NextRequest("http://localhost/api/test");

    await expect(authorizeApiRequest(request, "MANAGE_SYSTEM")).resolves.toEqual({
      ok: true,
      identity: null,
    });
  });
});
