import { describe, expect, it, vi } from "vitest";
import { SupabaseIncidentHistoryRepository } from "@/repositories/supabase/SupabaseIncidentHistoryRepository";

describe("SupabaseIncidentHistoryRepository", () => {
  it("loads a bounded recent history per incident through the database RPC", async () => {
    const rows = [
      { incident_id: "incident-a", recorded_at: "2026-09-02T06:00:00Z" },
      { incident_id: "incident-b", recorded_at: "2026-09-02T06:00:00Z" },
    ];
    const rpc = vi.fn().mockResolvedValue({ data: rows, error: null });
    const repository = new SupabaseIncidentHistoryRepository({ rpc } as any);

    const result = await repository.getHistoriesByIncidentIds(["incident-a", "incident-b"]);

    expect(rpc).toHaveBeenCalledWith("get_recent_incident_histories", {
      p_incident_ids: ["incident-a", "incident-b"],
      p_limit_per_incident: 5,
    });
    expect(result.get("incident-a")).toHaveLength(1);
    expect(result.get("incident-b")).toHaveLength(1);
  });
});
