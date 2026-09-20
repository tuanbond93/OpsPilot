import { describe, expect, it, vi } from "vitest";
import { NATURAL_SHADOW_PILOT_WAREHOUSES, runNaturalShadowObserverSafely } from "@/services/inbound-natural-shadow-observer";

describe("Natural Shadow observer contract", () => {
  it("evaluates exactly the fixed three warehouses and rejects non-scheduler execution", async () => {
    expect(NATURAL_SHADOW_PILOT_WAREHOUSES.map((w) => w.id)).toEqual(["21161000", "21158000", "21160000"]);
    const result = await runNaturalShadowObserverSafely({} as any, { checkpointAt: new Date().toISOString(), syncRunId: "run", trustedScheduler: false });
    expect(result).toMatchObject({ status: "FAILED", reason: "NATURAL_SHADOW_NOT_TRUSTED_SCHEDULER_PATH", warehousesEvaluated: 0 });
  });

  it("uses only the RPC for persistence and remains isolated from business side effects", async () => {
    const sourceRows = [{ order_code: "o1", current_warehouse_id: "upstream", deliver_warehouse_id: "21161000", source_status: "transporting", end_pick_at: null, weight_kg: null, is_b2b: true, source_observed_at: "2026-09-20T00:00:00Z" }];
    const calls: string[] = [];
    const builder = (table: string) => {
      calls.push(`from:${table}`);
      const q: any = { select: () => q, eq: () => q, order: () => q, limit: () => q, maybeSingle: async () => table === "sync_runs" ? { data: { id: "run", status: "success", source_updated_at: "2026-09-20T00:00:00Z" }, error: null } : { data: { source_system: "RILLNET", population_status: "COMPLETE", expected_observation_count: 1, persisted_observation_count: 1, duplicate_conflict_count: 0 }, error: null }, range: async () => ({ data: sourceRows, error: null }) };
      return q;
    };
    const client: any = { from: builder, rpc: vi.fn(async () => ({ data: { status: "ALREADY_OBSERVED", checkpoint_id: "cp" }, error: null })) };
    // Routing is deliberately not bypassed: missing routing fails closed before RPC.
    const result = await runNaturalShadowObserverSafely(client, { checkpointAt: "2026-09-20T01:00:00.000Z", syncRunId: "run", trustedScheduler: true });
    expect(result.status).toBe("FAILED");
    expect(client.rpc).not.toHaveBeenCalled();
    expect(calls).not.toContain("from:order_snapshots");
  });
});
