import { describe, expect, it } from "vitest";
import { assessProductionReadiness } from "../security/production-readiness";

describe("production readiness", () => {
  it("requires auth, Supabase credentials, and cron authentication in production", () => {
    const result = assessProductionReadiness({ NODE_ENV: "production" });

    expect(result.production).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.checks.map((check) => check.key)).toEqual([
      "auth_enforcement", "supabase_url", "supabase_anon_key", "supabase_service_role", "cron_secret",
    ]);
    expect(result.checks.every((check) => !check.ready)).toBe(true);
  });

  it("does not claim a local environment is a deploy blocker", () => {
    const result = assessProductionReadiness({ NODE_ENV: "test" });

    expect(result.production).toBe(false);
    expect(result.ready).toBe(true);
  });

  it("becomes ready only with every required production control", () => {
    const result = assessProductionReadiness({
      NODE_ENV: "production",
      AUTH_ENFORCEMENT_ENABLED: "true",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
      CRON_SECRET: "test-cron-secret",
    });

    expect(result.ready).toBe(true);
  });
});
