import { describe, it, expect, vi, beforeEach } from "vitest";
import { projectWarehouse } from "../projections/warehouse-projection";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("Phase 2: Warehouse Projection Tests", () => {
  let mockSupabase: any;

  beforeEach(() => {
    vi.restoreAllMocks();

    // Default mock behavior
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
    const result = await projectWarehouse(mockSupabase as any as SupabaseClient);
    expect(result.status).toBe("success");
    expect(result.rowsUpdated).toBe(0);
    expect(mockSupabase.rpc).not.toHaveBeenCalled();
  });

  it("2. Correctly maps DTO shape and calls upsert_warehouse_summary with correct parameters", async () => {
    // Mock latest sync run
    const mockSyncRun = { id: "sync-123", completed_at: "2026-08-05T12:00:00Z" };
    // Mock order snapshots
    const mockSnapshots = [
      { warehouse_id: "WH-1", warehouse_name: "Warehouse 1", age_hours: 10 },
      { warehouse_id: "WH-1", warehouse_name: "Warehouse 1", age_hours: 20 },
      { warehouse_id: "WH-2", warehouse_name: "Warehouse 2", age_hours: 5 },
    ];
    // Mock open incidents
    const mockIncidents = [
      { id: "inc-1", warehouse_id: "WH-1", priority_score: 50 },
      { id: "inc-2", warehouse_id: "WH-1", priority_score: 80 }, // critical
    ];
    // Mock follow-up cases
    const mockFollowups = [
      { incident_id: "inc-1", current_state: "FOLLOWING_UP" },
    ];
    // Mock planner drafts
    const mockPlannerDrafts = [
      { incident_id: "inc-2" },
    ];
    // Mock notification actions
    const mockNotifications = [
      { target_id: "inc-1" },
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
          if (table === "order_snapshots") data = mockSnapshots;
          else if (table === "incidents") data = mockIncidents;
          else if (table === "followup_cases") data = mockFollowups;
          else if (table === "planner_runs") data = mockPlannerDrafts;
          else if (table === "notification_actions") data = mockNotifications;
          return Promise.resolve(callback({ data, error: null }));
        }),
      };
      return chain;
    });

    const result = await projectWarehouse(mockSupabase as any as SupabaseClient);

    expect(result.status).toBe("success");
    expect(result.rowsUpdated).toBe(2);

    expect(mockSupabase.rpc).toHaveBeenCalledWith("upsert_warehouse_summary", {
      rows: [
        {
          warehouse_id: "WH-1",
          warehouse_name: "Warehouse 1",
          active_incidents: 2,
          critical_incidents: 1,
          followups_waiting: 1,
          notifications_pending: 1,
          planner_drafts: 1,
          average_age_hours: 15,
          health: "critical",
          last_sync: "2026-08-05T12:00:00Z",
        },
        {
          warehouse_id: "WH-2",
          warehouse_name: "Warehouse 2",
          active_incidents: 0,
          critical_incidents: 0,
          followups_waiting: 0,
          notifications_pending: 0,
          planner_drafts: 0,
          average_age_hours: 5,
          health: "healthy",
          last_sync: "2026-08-05T12:00:00Z",
        },
      ],
      present_ids: ["WH-1", "WH-2"],
    });
  });

  it("3. Returns status = failed and preserves RPC error messages on database failure", async () => {
    // Mock latest sync run
    const mockSyncRun = { id: "sync-123", completed_at: "2026-08-05T12:00:00Z" };
    // Mock order snapshots
    const mockSnapshots = [{ warehouse_id: "WH-1", warehouse_name: "Warehouse 1", age_hours: 10 }];

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
          if (table === "order_snapshots") data = mockSnapshots;
          return Promise.resolve(callback({ data, error: null }));
        }),
      };
      return chain;
    });

    // Mock RPC failure
    mockSupabase.rpc.mockResolvedValue({ data: null, error: { message: "Database constraint violation" } });

    const result = await projectWarehouse(mockSupabase as any as SupabaseClient);

    expect(result.status).toBe("failed");
    expect(result.rowsUpdated).toBe(0);
    expect(result.errorMessage).toContain("Database constraint violation");
  });
});
