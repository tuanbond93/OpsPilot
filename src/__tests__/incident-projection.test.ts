import { describe, it, expect, vi, beforeEach } from "vitest";
import { projectIncident } from "../projections/incident-projection";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("Phase 3: Incident Projection Tests", () => {
  let mockSupabase: any;

  beforeEach(() => {
    vi.restoreAllMocks();

    mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        let chain: any = {
          select: vi.fn().mockImplementation(() => chain),
          eq: vi.fn().mockImplementation(() => chain),
          in: vi.fn().mockImplementation(() => chain),
          order: vi.fn().mockImplementation(() => chain),
          limit: vi.fn().mockImplementation(() => chain),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
        return chain;
      }),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
  });

  it("1. Returns rowsUpdated = 0 on success when no source rows exist (no sync run)", async () => {
    const result = await projectIncident(mockSupabase as any as SupabaseClient);
    expect(result.status).toBe("success");
    expect(result.rowsUpdated).toBe(0);
    expect(mockSupabase.rpc).not.toHaveBeenCalled();
  });

  it("2. Correctly maps DTO shape and calls upsert_incident_summary with correct parameters", async () => {
    const mockSyncRun = { id: "sync-123", completed_at: "2026-08-05T12:00:00Z" };
    const mockIncidents = [
      { id: "inc-1", status: "open", priority_score: 80 }, // critical
      { id: "inc-2", status: "monitoring", priority_score: 40 }, // healthy
    ];
    const mockFollowups = [
      { incident_id: "inc-1", current_state: "FOLLOWING_UP" },
    ];
    const mockPlannerDrafts = [
      { incident_id: "inc-1", status: "DRAFT", result: { confidence: 0.95 } },
    ];
    const mockNotifications = [
      { target_id: "inc-1", status: "PENDING" },
    ];
    const mockHistories = [
      { incident_id: "inc-1", priority_score: 60, recorded_at: "2026-08-05T11:00:00Z" },
      { incident_id: "inc-1", priority_score: 80, recorded_at: "2026-08-05T12:00:00Z" },
    ];

    mockSupabase.from = vi.fn().mockImplementation((table: string) => {
      let chain: any = {
        select: vi.fn().mockImplementation(() => chain),
        eq: vi.fn().mockImplementation(() => chain),
        in: vi.fn().mockImplementation(() => chain),
        order: vi.fn().mockImplementation(() => chain),
        limit: vi.fn().mockImplementation(() => chain),
        maybeSingle: vi.fn().mockImplementation(async () => {
          if (table === "sync_runs") return { data: mockSyncRun, error: null };
          return { data: null, error: null };
        }),
        then: vi.fn().mockImplementation((callback) => {
          let data: any = [];
          if (table === "incidents") data = mockIncidents;
          else if (table === "followup_cases") data = mockFollowups;
          else if (table === "planner_runs") data = mockPlannerDrafts;
          else if (table === "notification_actions") data = mockNotifications;
          else if (table === "incident_histories") data = mockHistories;
          return Promise.resolve(callback({ data, error: null }));
        }),
      };
      return chain;
    });

    const result = await projectIncident(mockSupabase as any as SupabaseClient);

    expect(result.status).toBe("success");
    expect(result.rowsUpdated).toBe(2);

    expect(mockSupabase.rpc).toHaveBeenCalledWith("upsert_incident_summary", {
      rows: [
        {
          incident_id: "inc-1",
          priority: "critical",
          trend: "rising",
          risk: "high",
          followup_state: "FOLLOWING_UP",
          planner_status: "DRAFT",
          notification_status: "PENDING",
          latest_root_cause_confidence: null,
          latest_planner_confidence: 0.95,
        },
        {
          incident_id: "inc-2",
          priority: "healthy",
          trend: "stable",
          risk: "low",
          followup_state: "NEW",
          planner_status: "NONE",
          notification_status: "IDLE",
          latest_root_cause_confidence: null,
          latest_planner_confidence: null,
        },
      ],
      present_ids: ["inc-1", "inc-2"],
    });
  });

  it("3. Returns status = failed and preserves RPC error messages on database failure", async () => {
    const mockSyncRun = { id: "sync-123", completed_at: "2026-08-05T12:00:00Z" };
    const mockIncidents = [{ id: "inc-1", status: "open", priority_score: 80 }];

    mockSupabase.from = vi.fn().mockImplementation((table: string) => {
      let chain: any = {
        select: vi.fn().mockImplementation(() => chain),
        eq: vi.fn().mockImplementation(() => chain),
        in: vi.fn().mockImplementation(() => chain),
        order: vi.fn().mockImplementation(() => chain),
        limit: vi.fn().mockImplementation(() => chain),
        maybeSingle: vi.fn().mockImplementation(async () => {
          if (table === "sync_runs") return { data: mockSyncRun, error: null };
          return { data: null, error: null };
        }),
        then: vi.fn().mockImplementation((callback) => {
          let data: any = [];
          if (table === "incidents") data = mockIncidents;
          return Promise.resolve(callback({ data, error: null }));
        }),
      };
      return chain;
    });

    mockSupabase.rpc.mockResolvedValue({ data: null, error: { message: "Database constraint violation" } });

    const result = await projectIncident(mockSupabase as any as SupabaseClient);

    expect(result.status).toBe("failed");
    expect(result.rowsUpdated).toBe(0);
    expect(result.errorMessage).toContain("Database constraint violation");
  });
});
