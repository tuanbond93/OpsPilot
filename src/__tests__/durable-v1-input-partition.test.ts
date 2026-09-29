import { describe, expect, it, vi } from "vitest";
import { persistDurableV1Input, seedDurableV1Followups, durableV1InputHash } from "@/services/durable-v1-followup";
import { executeDurableV1CaseUnit, journaledV1Cursor, persistedV1PartitionCount, seedFinalizerIfDrained } from "@/services/durable-v1-worker";
import type { Incident } from "@/engine/incident";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet/types";

function mockIncident(key: string, affectedOrders: string[] = []): Incident {
  return {
    incidentId: `uuid-${key}`,
    incidentKey: key,
    warehouseId: "WH1",
    warehouseName: "Warehouse 1",
    reasonCode: "KHO_TON",
    reasonName: "Kho tồn",
    status: "open",
    priorityScore: 50,
    firstDetectedAt: "2026-09-28T01:00:00.000Z",
    lastDetectedAt: "2026-09-28T01:00:00.000Z",
    affectedOrderCount: affectedOrders.length,
    affectedOrders,
    sampleOrderCodes: affectedOrders.slice(0, 3),
    averageAgeHours: 5,
    maximumAgeHours: 10,
    oldestOrderCode: affectedOrders[0] || null,
  };
}

function mockOrder(code: string): NormalizedRillnetOrder {
  return {
    id: `id-${code}`,
    orderCode: code,
    customerId: `cust-${code}`,
    customerName: "Test Customer",
    customerCode: `CUST_${code}`,
    taskCategory: "standard",
    createdAt: "2026-09-28T01:00:00.000Z",
    warehouseId: "WH1",
    warehouseName: "Kho Giao Hang Nang Hub",
    deliverWarehouseId: "WH1",
    status: "delivering",
    fetchedAt: "2026-09-28T01:00:00.000Z",
  };
}

describe("Durable V1 Partitioned Input", () => {
  it("derives finalizer expected units from persisted partition rows", async () => {
    const eq = vi.fn().mockResolvedValue({ count: 2, error: null });
    const select = vi.fn().mockReturnValue({ eq });
    const client: any = { from: vi.fn().mockReturnValue({ select }) };
    await expect(persistedV1PartitionCount(client, "sync-policy-b")).resolves.toBe(2);
    expect(client.from).toHaveBeenCalledWith("checkpoint_v1_followup_input_chunks");
    expect(select).toHaveBeenCalledWith("chunk_index", { count: "exact", head: true });
    expect(eq).toHaveBeenCalledWith("sync_run_id", "sync-policy-b");
  });

  it("seeds the finalizer from variable persisted partition count, not candidate-count arithmetic", async () => {
    const checkpointAt = "2026-09-29T07:00:00.000Z";
    const syncRunId = "sync-policy-b-finalizer";
    let finalizerRows: any[] = [];
    const completedRows = [0, 1].map(index => ({
      id: `unit-${index}`, checkpoint_at: checkpointAt, sync_run_id: syncRunId,
      work_type: "EVALUATE_FOLLOWUP_BATCH", stage: "FOLLOWUPS_PROCESSING",
      partition_key: `v1_followup_${index}_of_2`, cursor: { metadata: { pipelineVersion: "V1", chunkIndex: index } },
      status: "COMPLETED", execution_mode: "PRODUCTION", attempts: 1, max_attempts: 3,
      idempotency_key: `${checkpointAt}:${syncRunId}:V1:${index}`,
    }));
    const client: any = { from: vi.fn((table: string) => {
      if (table === "checkpoint_v1_followup_input_chunks") return {
        select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ count: 2, error: null }) }),
      };
      if (table === "checkpoint_v1_followup_inputs") return {
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { candidate_keys: Array.from({ length: 25 }, (_, i) => `C${i}`), producer_completed_at: checkpointAt }, error: null }),
      };
      if (table === "checkpoint_work_units") return {
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({ data: completedRows, error: null }),
        upsert: vi.fn((rows: any[]) => {
          finalizerRows = rows;
          return { select: vi.fn().mockResolvedValue({ data: [{ id: "finalizer" }], error: null }) };
        }),
      };
      return {};
    }) };

    await expect(seedFinalizerIfDrained(client, checkpointAt, syncRunId)).resolves.toBe(true);
    expect(finalizerRows).toHaveLength(1);
    expect(finalizerRows[0].work_type).toBe("FINALIZE_V1_CHECKPOINT");
  });

  it("drops consumed chunk orders when journaling the replay plan", () => {
    const cursor = journaledV1Cursor({
      cursor: { offset: 0, limit: 25, total: 25, metadata: {
        pipelineVersion: "V1", chunkIndex: 0, caseKeys: ["INC1"], chunkOrders: [{ orderCode: "ORD1" }],
      } },
    } as any, { mutations: [], params: [], actions: [], results: [], candidateCount: 1, skippedUnchangedNotDue: 0 });

    expect(cursor.metadata?.chunkOrders).toBeUndefined();
    expect(cursor.metadata?.caseKeys).toEqual(["INC1"]);
    expect(cursor.metadata?.plan).toMatchObject({ candidateCount: 1 });
  });

  it("persists lightweight manifest with empty orders array and deterministic hash", async () => {
    let insertedPayload: any = null;
    const mockClient: any = {
      from: vi.fn((table: string) => {
        if (table === "checkpoint_v1_followup_inputs") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            insert: vi.fn(async (payload) => {
              insertedPayload = payload;
              return { error: null };
            }),
          };
        }
        return {};
      }),
    };

    const orders = [mockOrder("ORD1"), mockOrder("ORD2")];
    const incidents = [mockIncident("INC1", ["ORD1"])];

    await persistDurableV1Input(mockClient, {
      checkpointAt: "2026-09-28T01:00:00.000Z",
      syncRunId: "sync-test-1",
      referenceTimeMs: 1790557200000,
      orders,
      incidents,
    });

    expect(insertedPayload).not.toBeNull();
    expect(insertedPayload.orders).toEqual([]); // Manifest orders is empty
    expect(insertedPayload.incidents).toHaveLength(1);
    expect(insertedPayload.input_sha256).toBe(durableV1InputHash("2026-09-28T01:00:00.000Z", [], incidents));
  });

  it("seeds work units with chunkOrders attached in cursor metadata and saves chunks table", async () => {
    const orders = [mockOrder("ORD1"), mockOrder("ORD2"), mockOrder("ORD3")];
    const incidents = [
      mockIncident("INC1", ["ORD1"]),
      mockIncident("INC2", ["ORD2"]),
    ];

    let savedChunks: any[] = [];
    let createdWorkUnits: any[] = [];

    const mockClient: any = {
      from: vi.fn((table: string) => {
        if (table === "checkpoint_v1_followup_inputs") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: {
                checkpoint_at: "2026-09-28T01:00:00.000Z",
                incidents,
                candidate_keys: [],
                producer_completed_at: null,
              },
              error: null,
            }),
            update: vi.fn().mockReturnThis(),
            is: vi.fn().mockResolvedValue({ error: null }),
          };
        }
        if (table === "followup_cases") {
          return {
            select: vi.fn().mockReturnThis(),
            neq: vi.fn().mockReturnThis(),
            not: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        if (table === "checkpoint_v1_followup_input_chunks") {
          return {
            upsert: vi.fn(async (rows) => {
              savedChunks = rows;
              return { error: null };
            }),
          };
        }
        if (table === "checkpoint_work_units") {
          return {
            upsert: vi.fn((units) => {
              createdWorkUnits = units;
              return {
                select: vi.fn().mockResolvedValue({
                  data: units.map((u: any, i: number) => ({ id: `unit-${i}` })),
                  error: null,
                }),
              };
            }),
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockImplementation(() =>
              Promise.resolve({
                data: createdWorkUnits.map((u, i) => ({ ...u, id: `unit-${i}` })),
                error: null,
              })
            ),
          };
        }
        return {};
      }),
    };

    const result = await seedDurableV1Followups(
      mockClient,
      "2026-09-28T01:00:00.000Z",
      "sync-test-2",
      { orders }
    );

    expect(result.candidateCount).toBe(2);
    expect(result.workUnits).toBe(1);
    expect(savedChunks).toHaveLength(1);
    expect(savedChunks[0].orders).toHaveLength(2); // Only ORD1, ORD2 projected
    expect(savedChunks[0].orders[0].orderCode).toBe("ORD1");
    expect(savedChunks[0].incidents).toHaveLength(2);

    expect(createdWorkUnits).toHaveLength(1);
    expect(createdWorkUnits[0].cursor.metadata.chunkOrders).toHaveLength(2);
    expect(createdWorkUnits[0].cursor.metadata.chunkOrders[0].orderCode).toBe("ORD1");
  });

  it("executes work unit using chunkOrders from cursor metadata without querying giant orders", async () => {
    const checkpointAt = "2026-09-28T01:00:00.000Z";
    const syncRunId = "11111111-1111-4111-8111-111111111111";
    const incidents = [mockIncident("INC1", ["ORD1"])];
    const chunkOrders = [{
      orderCode: "ORD1",
      customerId: "cust-ORD1",
      warehouseId: "WH1",
      stage: "DELIVERY" as const,
      status: "delivering",
      observedAt: checkpointAt,
      readyAt: checkpointAt,
      source: "rillnet" as const,
      fetchedAt: checkpointAt,
    }];

    const unit: any = {
      id: "unit-123",
      checkpointAt,
      syncRunId,
      stage: "FOLLOWUPS_PROCESSING",
      workType: "EVALUATE_FOLLOWUP_BATCH",
      executionMode: "PRODUCTION",
      cursor: {
        offset: 0,
        limit: 1,
        total: 1,
        metadata: {
          pipelineVersion: "V1",
          chunkIndex: 0,
          caseKeys: ["INC1"],
          chunkOrders,
        },
      },
    };

    let insertedMembers: any[] = [];
    let currentGenStatus = "PREPARING";
    const mockClient: any = {
      rpc: vi.fn().mockResolvedValue({
        data: [{ incident_key: "INC1", id: "case-1" }],
        error: null,
      }),
      from: vi.fn((table: string) => {
        if (table === "checkpoint_v1_followup_inputs") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: {
                checkpoint_at: checkpointAt,
                reference_time_ms: 1790557200000,
                orders: [], // empty manifest orders
                incidents,
                candidate_keys: ["INC1"],
                producer_completed_at: checkpointAt,
                input_sha256: durableV1InputHash(checkpointAt, [], incidents),
              },
              error: null,
            }),
          };
        }
        if (table === "followup_cases") {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({ data: [], error: null }),
            or: vi.fn().mockResolvedValue({ data: [], error: null }),
            upsert: vi.fn().mockResolvedValue({ data: [{ incident_key: "INC1", id: "case-1" }], error: null }),
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockResolvedValue({
                data: [{ incident_key: "INC1", id: "case-1", updated_at: checkpointAt }],
                error: null,
              }),
            }),
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnThis(),
              select: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { id: "case-1", incident_key: "INC1", updated_at: checkpointAt },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "followup_case_member_generations") {
          return {
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockResolvedValue({
                data: [{
                  followup_case_id: "case-1",
                  generation_id: syncRunId,
                  source_sync_run_id: syncRunId,
                  expected_member_count: 1,
                  generation_status: "PREPARING",
                }],
                error: null,
              }),
            }),
            update: vi.fn((patch: any) => {
              if (patch.generation_status) currentGenStatus = patch.generation_status;
              return {
                eq: vi.fn().mockReturnThis(),
                in: vi.fn().mockReturnValue({
                  select: vi.fn().mockResolvedValue({
                    data: [{ followup_case_id: "case-1" }],
                    error: null,
                  }),
                }),
              };
            }),
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockImplementation((...args) => {
              const ret = {
                data: [{
                  followup_case_id: "case-1",
                  generation_id: syncRunId,
                  source_sync_run_id: syncRunId,
                  expected_member_count: 1,
                  generation_status: "COMMITTED",
                  committed_at: checkpointAt,
                }],
                error: null,
              };
              return Promise.resolve(ret);
            }),
          };
        }
        if (table === "followup_case_members") {
          return {
            upsert: vi.fn((rows: any[]) => {
              insertedMembers = [...rows];
              return {
                select: vi.fn().mockResolvedValue({ data: insertedMembers, error: null }),
              };
            }),
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            range: vi.fn().mockImplementation(() => Promise.resolve({ data: insertedMembers, error: null })),
          };
        }
        if (table === "checkpoint_work_units") {
          return {
            update: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            select: vi.fn().mockResolvedValue({ data: [{ id: "unit-123" }], error: null }),
          };
        }
        const chainable: any = {
          select: vi.fn().mockReturnThis(),
          insert: vi.fn().mockReturnValue({ select: vi.fn().mockResolvedValue({ data: [], error: null }) }),
          upsert: vi.fn().mockReturnValue({
            select: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
          update: vi.fn().mockReturnThis(),
          delete: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          range: vi.fn().mockResolvedValue({ data: [], error: null }),
        };
        return chainable;
      }),
    };

    const res = await executeDurableV1CaseUnit(mockClient, unit, "worker-1");
    expect(res.itemsProcessed).toBe(1);
  });
});
