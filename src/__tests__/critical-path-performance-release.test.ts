import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_EVENT_LIMIT,
  DASHBOARD_HISTORY_LIMIT_PER_INCIDENT,
  SupabaseDashboardRepository,
} from "@/repositories/supabase/SupabaseDashboardRepository";

type QueryResult = { data: unknown[] | null; error: unknown };

function makeQuery(result: QueryResult, calls: Array<{ method: string; value?: unknown }>) {
  const query: Record<string, any> = {};
  query.select = vi.fn((columns: string) => {
    calls.push({ method: "select", value: columns });
    return query;
  });
  query.order = vi.fn((column: string, options: unknown) => {
    calls.push({ method: "order", value: { column, options } });
    return query;
  });
  query.limit = vi.fn((limit: number) => {
    calls.push({ method: "limit", value: limit });
    return query;
  });
  query.gte = vi.fn((column: string, value: string) => {
    calls.push({ method: "gte", value: { column, value } });
    return query;
  });
  query.then = (resolve: (value: QueryResult) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return query;
}

describe("critical-path performance release", () => {
  it("uses the bounded per-incident history RPC and preserves latest/previous ordering", async () => {
    const calls: Array<{ method: string; value?: unknown }> = [];
    const tableRows: Record<string, unknown[]> = {
      incident_summary: [{ incident_id: "inc-a" }, { incident_id: "inc-b" }],
      incidents: [{ id: "inc-a", incident_key: "A" }, { id: "inc-b", incident_key: "B" }],
      followup_cases: [],
    };
    const historyRows = [
      { id: "a", incident_id: "inc-a", recorded_at: "2026-09-22T10:00:00.000Z", affected_order_count: 4 },
      { id: "z", incident_id: "inc-a", recorded_at: "2026-09-22T10:00:00.000Z", affected_order_count: 5 },
      { id: "b", incident_id: "inc-b", recorded_at: "2026-09-21T10:00:00.000Z", affected_order_count: 2 },
    ];
    const client = {
      from: vi.fn((table: string) => makeQuery({ data: tableRows[table] || [], error: null }, calls)),
      rpc: vi.fn((name: string, args: unknown) => {
        calls.push({ method: `rpc:${name}`, value: args });
        return makeQuery({ data: historyRows, error: null }, calls);
      }),
    } as any;

    const result = await new SupabaseDashboardRepository(client).getIncidentSummaries();

    expect(client.from).not.toHaveBeenCalledWith("incident_history");
    expect(client.rpc).toHaveBeenCalledWith("get_recent_incident_histories", {
      p_incident_ids: ["inc-a", "inc-b"],
      p_limit_per_incident: DASHBOARD_HISTORY_LIMIT_PER_INCIDENT,
    });
    expect(result[0].affected_order_count).toBe(5);
    expect(result[0].previous_affected_order_count).toBe(4);
    expect(result[1].affected_order_count).toBe(2);
    expect(result[1].previous_affected_order_count).toBeNull();
  });

  it("bounds dashboard event reads and selects only consumed fields", async () => {
    const calls: Array<{ method: string; value?: unknown }> = [];
    const client = {
      from: vi.fn(() => makeQuery({ data: [], error: null }, calls)),
    } as any;
    const repository = new SupabaseDashboardRepository(client);

    await repository.getRecentFollowupEvents(10_000);
    await repository.getRecentActionEvents(10_000);
    await repository.getRecentPlannerReviewEvents(10_000);

    expect(calls.filter((call) => call.method === "limit").map((call) => call.value)).toEqual([
      DASHBOARD_EVENT_LIMIT,
      DASHBOARD_EVENT_LIMIT,
      DASHBOARD_EVENT_LIMIT,
    ]);
    expect(calls.filter((call) => call.method === "select").map((call) => call.value)).toEqual([
      "id, followup_case_id, event_type, event_time, old_state, new_state, assessment, notes, confirmed_by, created_at",
      "id, action_id, event_type, created_at, old_status, new_status, provider",
      "id, planner_run_id, event_type, created_at, note, actor",
    ]);
  });

  it("removes the dashboard waterfall and automatic GHN/cache work from initial incident reads", () => {
    const detailPage = readFileSync(new URL("../app/incidents/[incidentId]/page.tsx", import.meta.url), "utf8");
    const incidentOrders = readFileSync(new URL("../app/incidents/[incidentId]/IncidentOrders.tsx", import.meta.url), "utf8");
    const startupValidator = readFileSync(new URL("../integrations/startup-validator.ts", import.meta.url), "utf8");

    expect(detailPage).not.toContain('requestJson("/api/dashboard")');
    expect(detailPage).toContain("/api/debug/incidents/${encodeURIComponent(incidentId)}/history");
    expect(incidentOrders).not.toContain("void analyzeAllOrders();");
    expect(incidentOrders).toContain('onClick={() => void analyzeAllOrders(true)}');
    expect(startupValidator).not.toContain("replace_vehicle_availability_fact");
    expect(startupValidator).not.toContain(".insert({");
  });
});
