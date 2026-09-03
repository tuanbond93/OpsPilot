import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../app/api/dashboard/route";
import { ServiceFactory } from "../services/ServiceFactory";

describe("Sprint 7 Hardened — Executive Operations Control Center Tests", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    process.env.AUTH_ENFORCEMENT_ENABLED = "false";
  });

  it("1. GET /api/dashboard returns 200 with bounded payloads, KPI split, timings, and health TTL metadata", async () => {
    const req = new Request("http://localhost:3000/api/dashboard");
    const response = await GET(req);

    expect(response.status).toBe(200);
    const json = await response.json();

    expect(json.ok).toBe(true);
    expect(["realtime", "unavailable"]).toContain(json.dataFreshness);
    expect(["database", "degraded_fallback"]).toContain(json.source);
    if (json.source === "degraded_fallback") expect(json.degraded).toBe(true);

    // 1. KPI Split Verification
    const kpis = json.kpis;
    expect(kpis).toHaveProperty("activeIncidents");
    expect(kpis).toHaveProperty("criticalRiskIncidents");
    expect(kpis).toHaveProperty("highPriorityIncidents");
    expect(kpis).toHaveProperty("averageIncidentDurationHours");
    expect(kpis).toHaveProperty("averageOldestOrderAgeHours");
    expect(kpis).toHaveProperty("incidentsResolvedToday");
    expect(kpis).toHaveProperty("aiJobsPending");
    expect(kpis).toHaveProperty("aiJobsRunning");
    expect(kpis).toHaveProperty("notificationsPending");
    expect(kpis).toHaveProperty("notificationsFailed");

    // 2. Bounded Payloads Verification
    expect(json.incidents).toHaveProperty("items");
    expect(json.incidents).toHaveProperty("totalCount");
    expect(json.incidents).toHaveProperty("displayedCount");
    expect(json.incidents).toHaveProperty("hasMore");

    expect(json.followups).toHaveProperty("items");
    expect(json.notifications).toHaveProperty("items");
    expect(json.plannerSummary.recentRecommendations).toHaveProperty("items");
    expect(json.timeline).toHaveProperty("items");

    // Payloads bounded to expected max items
    expect(json.incidents.items.length).toBeLessThanOrEqual(20);
    expect(json.followups.items.length).toBeLessThanOrEqual(20);
    expect(json.notifications.items.length).toBeLessThanOrEqual(20);
    expect(json.timeline.items.length).toBeLessThanOrEqual(30);

    // 3. Per-Repository Timings Verification
    expect(json.diagnostics.timings).toHaveProperty("incidentsMs");
    expect(json.diagnostics.timings).toHaveProperty("historiesMs");
    expect(json.diagnostics.timings).toHaveProperty("followupsMs");
    expect(json.diagnostics.timings).toHaveProperty("plannerMs");
    expect(json.diagnostics.timings).toHaveProperty("aiJobsMs");
    expect(json.diagnostics.timings).toHaveProperty("notificationsMs");
    expect(json.diagnostics.timings).toHaveProperty("syncRunMs");
    expect(json.diagnostics.timings).toHaveProperty("aggregationMs");
    expect(json.diagnostics.timings).toHaveProperty("totalMs");
  });

  it("2. Warehouse Scope Filtering filters incidents and KPIs correctly", async () => {
    const req = new Request("http://localhost:3000/api/dashboard?scope=WH-HN-01");
    const response = await GET(req);

    expect(response.status).toBe(200);
    const json = await response.json();

    expect(json.scope.configuredScope).toBe("WH-HN-01");
    expect(json.scope.appliedWarehouseFilter).toBe("WH-HN-01");

    for (const inc of json.incidents.items) {
      expect(["WH-HN-01", "Kho HN-01"]).toContain(inc.warehouseId || inc.warehouseName);
    }
  });

  it("3. Health Semantics include status, healthReason, lastSuccessAt, lastFailureAt, and freshnessSeconds", async () => {
    const req = new Request("http://localhost:3000/api/dashboard");
    const response = await GET(req);

    const json = await response.json();
    const health = json.health;

    expect(health.database).toHaveProperty("status");
    expect(health.database).toHaveProperty("healthReason");
    expect(health.database).toHaveProperty("lastSuccessAt");

    expect(health.aiWorker).toHaveProperty("status");
    expect(health.aiWorker).toHaveProperty("healthReason");

    expect(health.notificationPlatform).toHaveProperty("status");
    expect(health.notificationPlatform).toHaveProperty("healthReason");

    expect(health.aiProvider).toHaveProperty("status");
    expect(health.aiProvider).toHaveProperty("healthReason");
  });

  it("4. Production fails closed when auth enforcement is disabled", async () => {
    vi.stubEnv("ALLOW_IN_MEMORY_FALLBACK", "true");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_DASHBOARD_WRITE_CONTROLS", "false");

    const req = new Request("http://localhost:3000/api/dashboard");
    const response = await GET(req);

    const json = await response.json();
    expect(response.status).toBe(503);
    expect(json.error).toBe("AUTH_ENFORCEMENT_REQUIRED");
  });

  it("5. Route delegates to DashboardService", async () => {
    const spy = vi.spyOn(ServiceFactory, "getDashboardService");
    const req = new Request("http://localhost:3000/api/dashboard");
    await GET(req);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

});
