import { describe, it, expect, beforeEach, vi } from "vitest";
import { SecretProvider } from "../integrations/secrets";
import { HealthRegistry } from "../integrations/health";
import { TelegramClient } from "../integrations/telegram";
import { RillnetClient } from "../integrations/rillnet";
import { StartupValidator } from "../integrations/startup-validator";
import { SchedulerRunner } from "../integrations/scheduler";

describe("Sprint 8.1 — Production Integration Layer Tests", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    HealthRegistry.clear();
    SchedulerRunner.clear();
  });

  it("1. SecretProvider validates required keys and handles defaults", () => {
    // Force development environment
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://mock.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "mock-anon-key");
    vi.stubEnv("AI_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "mock-openai-key");

    const check = SecretProvider.validate();
    expect(check.ok).toBe(true);

    expect(SecretProvider.get("NEXT_PUBLIC_SUPABASE_URL")).toBe("https://mock.supabase.co");
    expect(SecretProvider.getOptional("OPTIONAL_KEY", "fallback")).toBe("fallback");
    expect(SecretProvider.getBoolean("BOOL_TRUE", true)).toBe(true);
    expect(SecretProvider.getNumber("NUM_KEY", 42)).toBe(42);
  });

  it("2. HealthRegistry registers checkable components and aggregates overall statuses", async () => {
    HealthRegistry.register({
      name: "Comp1",
      health: async () => ({
        status: "GREEN",
        healthReason: "All good",
        lastSuccessAt: new Date().toISOString(),
        lastFailureAt: null,
        freshnessSeconds: 0,
      }),
    });

    HealthRegistry.register({
      name: "Comp2",
      health: async () => ({
        status: "YELLOW",
        healthReason: "Stale",
        lastSuccessAt: null,
        lastFailureAt: null,
        freshnessSeconds: null,
      }),
    });

    const report = await HealthRegistry.checkAll();
    expect(report.overallStatus).toBe("YELLOW");
    expect(report.components.comp1.status).toBe("GREEN");
    expect(report.components.comp2.status).toBe("YELLOW");

    // Add a RED component
    HealthRegistry.register({
      name: "Comp3",
      health: async () => {
        throw new Error("Fatal DB Error");
      },
    });

    const report2 = await HealthRegistry.checkAll();
    expect(report2.overallStatus).toBe("RED");
    expect(report2.components.comp3.status).toBe("RED");
    expect(report2.components.comp3.healthReason).toContain("Fatal DB Error");
  });

  it("3. TelegramClient health check and sendMessage simulation modes", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    vi.stubEnv("TELEGRAM_CHAT_ID", "");

    const client = new TelegramClient();
    const health = await client.health();
    // Unconfigured yields UNKNOWN health status
    expect(health.status).toBe("UNKNOWN");

    const sendRes = await client.sendMessage("Hello Test");
    expect(sendRes.messageId).toContain("tg-sim");
    expect(sendRes.response.simulated).toBe(true);
  });

  it("4. TelegramClient handles 429 rate limits and retries", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "mock-token");
    vi.stubEnv("TELEGRAM_CHAT_ID", "mock-chat");

    const client = new TelegramClient();

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          status: 429,
          ok: false,
          json: () => Promise.resolve({ ok: false, description: "Too Many Requests", parameters: { retry_after: 0.01 } }),
        });
      }
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { message_id: 12345 } }),
      });
    });

    vi.stubGlobal("fetch", mockFetch);

    const res = await client.sendMessage("Escaped text");
    expect(res.messageId).toBe("12345");
    expect(callCount).toBe(2);
  });

  it("4b. TelegramClient is healthy with a bot token when pilot chats are mapped dynamically", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "mock-token");
    vi.stubEnv("TELEGRAM_CHAT_ID", "");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const health = await new TelegramClient().health();

    expect(health.status).toBe("GREEN");
    expect(health.healthReason).toContain("mapped pilot groups");
  });

  it("5. RillnetClient handles network retries and timeout", async () => {
    vi.stubEnv("RILLNET_TIMEOUT_MS", "10");
    vi.stubEnv("RILLNET_MAX_RETRIES", "2");

    const client = new RillnetClient();

    let attempts = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      attempts++;
      return Promise.reject(new Error("Timeout/Network Failure"));
    });

    vi.stubGlobal("fetch", mockFetch);

    await expect(client.requestSnapshotUrl()).rejects.toThrow();
    expect(attempts).toBe(2);
  });

  it("6. StartupValidator runs full health checks and returns structured startup report", async () => {
    vi.stubEnv("ALLOW_IN_MEMORY_FALLBACK", "true");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://mock.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "mock-anon");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "mock-role-key");
    vi.stubEnv("AI_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "mock-key");

    // Stub fetch to return success for health checks (e.g. telegram getMe, etc.)
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, result: { username: "mock_bot" } }),
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    // Mock createAdminClient to return a dummy db client
const supabaseConnector = await import("@/connectors/supabase");
    vi.spyOn(supabaseConnector, "createAdminClient").mockReturnValue({
      from: () => ({
        select: () => ({
          limit: () => Promise.resolve({ data: [{ id: 1 }], error: null }),
        }),
      }),
    } as any);

    const report = await StartupValidator.run();
    expect(report.success).toBe(true);
    expect(report.secrets.ok).toBe(true);
    expect(report.scheduler.ok).toBe(true);
    expect(HealthRegistry.getCheckers().length).toBeGreaterThan(0);
  });

  it("7. SchedulerRunner registers declarative jobs and maintains execution logs", async () => {
    let executed = false;
    SchedulerRunner.clear();
    SchedulerRunner.register({
      name: "test-job",
      description: "Test run",
      schedule: "* * * * *",
      enabled: true,
      handler: async () => {
        executed = true;
        return { success: true, details: "Executed test run successfully" };
      },
    });

    const runner = new SchedulerRunner();
    const res = await runner.runJob("test-job");
    expect(executed).toBe(true);
    expect(res.status).toBe("SUCCESS");
    expect(res.details).toBe("Executed test run successfully");

    const history = SchedulerRunner.getExecutionHistory();
    expect(history.length).toBe(1);
    expect(history[0].jobName).toBe("test-job");
    expect(history[0].status).toBe("SUCCESS");
  });
});
