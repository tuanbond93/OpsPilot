import { describe, expect, it, vi } from "vitest";
import { NATURAL_SHADOW_PILOT_WAREHOUSES, runNaturalShadowObserverSafely } from "@/services/inbound-natural-shadow-observer";
import { logger } from "@/observability/logger";

const checkpointAt = "2026-09-20T07:00:00.000Z";
const sourceRows = [{ order_code: "private-order-code", current_warehouse_id: "upstream", deliver_warehouse_id: "21161000", source_status: "transporting", end_pick_at: null, weight_kg: null, is_b2b: true, source_observed_at: "2026-09-20T06:00:00.000Z" }];

function observerClient(overrides: { observationError?: string; topicRows?: any[]; rpc?: () => Promise<any> } = {}) {
  const topics = overrides.topicRows ?? [
    { id: "topic-yb", group_id: "group-yb", message_thread_id: 11, province_name: "Yên Bái", status: "ACTIVE", is_manager_decision: false },
    { id: "topic-lc", group_id: "group-lc", message_thread_id: 12, province_name: "Lào Cai", status: "ACTIVE", is_manager_decision: false },
    { id: "topic-pt", group_id: "group-pt", message_thread_id: 13, province_name: "Phú Thọ", status: "ACTIVE", is_manager_decision: false },
  ];
  const groups = [
    { id: "group-yb", telegram_chat_id: "1001", status: "ACTIVE" },
    { id: "group-lc", telegram_chat_id: "1002", status: "ACTIVE" },
    { id: "group-pt", telegram_chat_id: "1003", status: "ACTIVE" },
  ];
  const from = (table: string) => {
    const q: any = { select: () => q, eq: () => q, in: () => q };
    q.maybeSingle = async () => table === "sync_runs"
      ? { data: { id: "run", checkpoint_at: checkpointAt }, error: null }
      : { data: { source_system: "RILLNET", population_status: "COMPLETE", population_completed_at: checkpointAt, source_freshness: "2026-09-20T06:00:00.000Z", expected_observation_count: 1, persisted_observation_count: 1, duplicate_conflict_count: 0 }, error: null };
    q.range = async () => ({ data: overrides.observationError ? null : sourceRows, error: overrides.observationError ? { message: overrides.observationError } : null });
    q.then = undefined;
    // Topic/group reads await their query builder through Supabase's thenable API.
    q[Symbol.toStringTag] = "Promise";
    q.then = (resolve: any) => resolve(table === "telegram_pilot_topics" ? { data: topics, error: null } : { data: groups, error: null });
    return q;
  };
  return { from, rpc: vi.fn(overrides.rpc ?? (async () => ({ data: { status: "OBSERVED", checkpoint_id: "checkpoint" }, error: null }))) } as any;
}

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

  it("emits safe start/pass telemetry and COMPLETE after an inserted bundle", async () => {
    const log = vi.spyOn(logger, "info").mockImplementation(() => undefined as any);
    const client = observerClient();
    const result = await runNaturalShadowObserverSafely(client, { checkpointAt, syncRunId: "run", trustedScheduler: true });
    expect(result.status).toBe("SUCCESS_INSERTED");
    const events = log.mock.calls.map(([entry]) => entry);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "INBOUND_NATURAL_SHADOW_STAGE", stage: "OBSERVER_ENTER", status: "PASS" }),
      expect.objectContaining({ event: "INBOUND_NATURAL_SHADOW_STAGE", stage: "RPC_ATTEMPT", status: "START" }),
      expect.objectContaining({ event: "INBOUND_NATURAL_SHADOW_CONSTRAINT_SNAPSHOT", local_check_preflight: "PASS" }),
      expect.objectContaining({ event: "INBOUND_NATURAL_SHADOW_STAGE", stage: "RPC_RESULT", status: "PASS", result: "INSERTED" }),
      expect.objectContaining({ event: "INBOUND_NATURAL_SHADOW_COMPLETE", warehouse_count: 3, rpc_result: "INSERTED" }),
    ]));
    expect(JSON.stringify(events)).not.toContain("private-order-code");
    expect(JSON.stringify(events)).not.toContain("p_bundle");
    expect(JSON.stringify(events)).not.toContain("Kho Giao Hàng Nặng");
    log.mockRestore();
  });

  it("identifies observation reads, routing, and RPC failures without rethrowing", async () => {
    const log = vi.spyOn(logger, "info").mockImplementation(() => undefined as any);
    const readResult = await runNaturalShadowObserverSafely(observerClient({ observationError: "read denied" }), { checkpointAt, syncRunId: "run", trustedScheduler: true });
    expect(readResult.status).toBe("FAILED");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "INBOUND_NATURAL_SHADOW_FAILURE", failed_stage: "OBSERVATION_READ" }));
    log.mockClear();
    const routingResult = await runNaturalShadowObserverSafely(observerClient({ topicRows: [] }), { checkpointAt, syncRunId: "run", trustedScheduler: true });
    expect(routingResult.status).toBe("FAILED");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "INBOUND_NATURAL_SHADOW_FAILURE", failed_stage: "ROUTING_TOPIC_RESOLUTION" }));
    log.mockClear();
    const rpcResult = await runNaturalShadowObserverSafely(observerClient({ rpc: async () => { throw new Error("rpc unavailable"); } }), { checkpointAt, syncRunId: "run", trustedScheduler: true });
    expect(rpcResult.status).toBe("FAILED");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "INBOUND_NATURAL_SHADOW_FAILURE", failed_stage: "RPC_RESULT" }));
    log.mockRestore();
  });

  it("emits structured RPC diagnostics without a raw database dump", async () => {
    const log = vi.spyOn(logger, "info").mockImplementation(() => undefined as any);
    const result = await runNaturalShadowObserverSafely(observerClient({
      rpc: async () => ({ data: null, error: { name: "SupabaseError", code: "P0001", message: "INBOUND_EVIDENCE_V2_AUTHORITATIVE_MANIFEST_INVALID", details: "order_id=private", hint: "customer private" } }),
    }), { checkpointAt, syncRunId: "run", trustedScheduler: true });
    expect(result).toMatchObject({ status: "FAILED", reason: "INBOUND_EVIDENCE_V2_AUTHORITATIVE_MANIFEST_INVALID", warehousesEvaluated: 3 });
    const events = log.mock.calls.map(([entry]) => JSON.stringify(entry)).join("\n");
    expect(events).toContain("INBOUND_NATURAL_SHADOW_STAGE");
    expect(events).toContain("INBOUND_NATURAL_SHADOW_FAILURE");
    expect(events).toContain("P0001");
    expect(events).not.toContain("order_id=private");
    expect(events).not.toContain("customer private");
    expect(events).not.toContain("p_bundle");
    expect(events).toContain("local_check_preflight");
    log.mockRestore();
  });
});
