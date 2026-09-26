import { describe, expect, it, vi } from "vitest";
import { MockSyncRunRepository } from "@/repositories/mock/MockSyncRunRepository";
import { MockIncidentRepository } from "@/repositories/mock/MockIncidentRepository";
import { RillnetConnector } from "@/connectors/rillnet";
import { SyncService } from "@/services/impl/SyncService";
import type {
  IInboundOrderObservationRepository,
  InboundOrderObservationRow,
  InboundPopulationManifest,
  InboundPopulationManifestInput,
} from "@/repositories/interfaces/IInboundOrderObservationRepository";

/**
 * REGRESSION SUITE: 08H POPULATION SURPLUS & IDEMPOTENT REPLACEMENT
 *
 * Verifies that:
 * 1. An incomplete population is purged in a verified, fail-closed manner.
 * 2. Retrying a checkpoint after snapshot contraction does NOT produce union surplus.
 * 3. Parity validation succeeds with exact equality.
 * 4. Repeating the retry is strictly idempotent.
 */
describe("08h population surplus regression & idempotent replacement", () => {
  it("successfully replaces 14,684 initial observations with contracted 14,469 snapshot and passes parity", async () => {
    const CHECKPOINT_AT = "2026-09-26T01:00:00.000Z";
    const SYNC_RUN_ID = "1f098a06-1421-439c-8d02-287488059b9b";

    // Simulates the DB table public.inbound_order_observations
    const dbObservations = new Map<string, InboundOrderObservationRow>();

    // Seed the database with the 14,684 observations from the initial 08h attempt
    for (let i = 1; i <= 14684; i++) {
      const orderCode = `ORD-${String(i).padStart(6, "0")}`;
      dbObservations.set(orderCode, {
        sync_run_id: SYNC_RUN_ID,
        source_system: "RILLNET",
        order_code: orderCode,
        current_warehouse_id: "WH-NORTH",
        deliver_warehouse_id: "WH-HUB",
        source_status: "storing",
        end_pick_at: null,
        weight_kg: 1.5,
        is_b2b: false,
        source_observed_at: "2026-09-26T01:00:03.243Z",
      });
    }

    let manifestRecord: InboundPopulationManifest | null = {
      sync_run_id: SYNC_RUN_ID,
      source_system: "RILLNET",
      population_status: "FAILED",
      normalized_population_count: 14684,
      expected_observation_count: 14684,
      persisted_observation_count: 0,
      duplicate_identical_count: 0,
      duplicate_conflict_count: 0,
      source_freshness: "2026-09-26T01:00:03.243Z",
      population_completed_at: null,
      failure_reason: "PREVIOUS_FAILURE",
    };

    // Repository with fail-closed population replacement
    const observationRepo: IInboundOrderObservationRepository = {
      async getPopulationManifest(): Promise<InboundPopulationManifest | null> {
        return manifestRecord;
      },

      async replaceIncompletePopulation(input: InboundPopulationManifestInput): Promise<void> {
        manifestRecord = {
          ...input,
          population_status: "STARTED",
          persisted_observation_count: 0,
          population_completed_at: null,
        };
        // Scoped cleanup: clears observations for this sync_run_id & source_system
        dbObservations.clear();

        // Verify zero residual rows
        if (dbObservations.size !== 0) {
          throw new Error("INBOUND_POPULATION_REPLACEMENT_FAILED: residual observations remain after cleanup");
        }
      },

      async insertBatch(rows: InboundOrderObservationRow[]): Promise<number> {
        for (const row of rows) {
          if (!dbObservations.has(row.order_code)) {
            dbObservations.set(row.order_code, row);
          }
        }
        return rows.length;
      },

      async countPersisted(): Promise<number> {
        return dbObservations.size;
      },

      async completePopulation(input: InboundPopulationManifestInput & { persisted_observation_count: number; population_completed_at: string }): Promise<void> {
        manifestRecord = { ...input, population_status: "COMPLETE" };
      },

      async failPopulation(input: Pick<InboundPopulationManifestInput, "sync_run_id" | "source_system"> & { failure_reason: string }): Promise<void> {
        if (manifestRecord) {
          manifestRecord.population_status = "FAILED";
          manifestRecord.failure_reason = input.failure_reason;
        }
      },
    };

    // Contracted snapshot at 10h ICT has 14,469 orders (orders 1..14469).
    // 215 orders (14470..14684) have departed.
    const contractedOrders = Array.from({ length: 14469 }, (_, i) => ({
      orderCode: `ORD-${String(i + 1).padStart(6, "0")}`,
      warehouseId: "WH-NORTH",
      deliverWarehouseId: "WH-HUB",
      status: "storing",
      weightKg: 1.5,
      isB2b: false,
      fetchedAt: "2026-09-26T03:00:02.932Z",
    }));

    vi.spyOn(RillnetConnector.prototype, "fetchSnapshotUrlOnly").mockResolvedValue({
      downloadUrl: "https://example.test/snapshot-03h.gz",
      updatedAt: "2026-09-26T03:00:02.932Z",
    });
    vi.spyOn(RillnetConnector.prototype, "downloadBufferOnly").mockResolvedValue(new ArrayBuffer(0));
    vi.spyOn(RillnetConnector.prototype, "parseSnapshotFromBuffer").mockResolvedValue({
      totalOrders: 14469,
      fetchedAt: "2026-09-26T03:00:02.932Z",
      orders: contractedOrders,
    } as any);

    const syncRunRepo = new MockSyncRunRepository();
    await syncRunRepo.createSyncRun("2026-09-26T01:00:03.243Z", {
      id: SYNC_RUN_ID,
      checkpointAt: CHECKPOINT_AT,
    });
    await syncRunRepo.updatePhase(SYNC_RUN_ID, "PERSISTING_HISTORY", [
      "CREATED",
      "FETCHING_SNAPSHOT",
      "PERSISTING_SNAPSHOTS",
      "PERSISTING_INCIDENTS",
      "PERSISTING_HISTORY",
    ]);

    const service = new SyncService(
      syncRunRepo,
      null,
      new MockIncidentRepository(),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      observationRepo,
    );

    const result = await service.runSync({ checkpointAt: CHECKPOINT_AT });

    // Parity verification now passes
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(await observationRepo.countPersisted(SYNC_RUN_ID, "RILLNET")).toBe(14469);
    expect(manifestRecord?.population_status).toBe("COMPLETE");
    expect(manifestRecord?.persisted_observation_count).toBe(14469);
  });

  it("minimal fixture: S1=5, S2=3 (2 removed) -> persisted population is exactly 3 without accumulation", async () => {
    const CHECKPOINT_AT = "2026-09-26T01:00:00.000Z";
    const SYNC_RUN_ID = "00000000-0000-4000-8000-000000000002";

    const dbObservations = new Map<string, InboundOrderObservationRow>();

    // Initial attempt has 5 orders: ORD-1 .. ORD-5
    for (let i = 1; i <= 5; i++) {
      dbObservations.set(`ORD-${i}`, {
        sync_run_id: SYNC_RUN_ID,
        source_system: "RILLNET",
        order_code: `ORD-${i}`,
        current_warehouse_id: "WH-1",
        deliver_warehouse_id: "WH-2",
        source_status: "storing",
        end_pick_at: null,
        weight_kg: 1.0,
        is_b2b: false,
        source_observed_at: "2026-09-26T01:00:00.000Z",
      });
    }

    let manifestRecord: InboundPopulationManifest | null = {
      sync_run_id: SYNC_RUN_ID,
      source_system: "RILLNET",
      population_status: "FAILED",
      normalized_population_count: 5,
      expected_observation_count: 5,
      persisted_observation_count: 0,
      duplicate_identical_count: 0,
      duplicate_conflict_count: 0,
      source_freshness: "2026-09-26T01:00:00.000Z",
      population_completed_at: null,
      failure_reason: "PREVIOUS_FAILURE",
    };

    const observationRepo: IInboundOrderObservationRepository = {
      async getPopulationManifest() { return manifestRecord; },
      async replaceIncompletePopulation(input) {
        manifestRecord = { ...input, population_status: "STARTED", persisted_observation_count: 0, population_completed_at: null };
        dbObservations.clear();
      },
      async insertBatch(rows) {
        for (const row of rows) {
          if (!dbObservations.has(row.order_code)) dbObservations.set(row.order_code, row);
        }
        return rows.length;
      },
      async countPersisted() { return dbObservations.size; },
      async completePopulation(input) { manifestRecord = { ...input, population_status: "COMPLETE" }; },
      async failPopulation(input) { if (manifestRecord) { manifestRecord.population_status = "FAILED"; manifestRecord.failure_reason = input.failure_reason; } },
    };

    // S2 has only 3 orders: ORD-1, ORD-2, ORD-3 (ORD-4 and ORD-5 were removed)
    const s2Orders = [
      { orderCode: "ORD-1", warehouseId: "WH-1", deliverWarehouseId: "WH-2", status: "storing", weightKg: 1.0, isB2b: false },
      { orderCode: "ORD-2", warehouseId: "WH-1", deliverWarehouseId: "WH-2", status: "storing", weightKg: 1.0, isB2b: false },
      { orderCode: "ORD-3", warehouseId: "WH-1", deliverWarehouseId: "WH-2", status: "storing", weightKg: 1.0, isB2b: false },
    ];

    vi.spyOn(RillnetConnector.prototype, "fetchSnapshotUrlOnly").mockResolvedValue({ downloadUrl: "https://example.test/s2.gz", updatedAt: "2026-09-26T03:00:00.000Z" });
    vi.spyOn(RillnetConnector.prototype, "downloadBufferOnly").mockResolvedValue(new ArrayBuffer(0));
    vi.spyOn(RillnetConnector.prototype, "parseSnapshotFromBuffer").mockResolvedValue({ totalOrders: 3, fetchedAt: "2026-09-26T03:00:00.000Z", orders: s2Orders } as any);

    const syncRunRepo = new MockSyncRunRepository();
    await syncRunRepo.createSyncRun("2026-09-26T01:00:00.000Z", { id: SYNC_RUN_ID, checkpointAt: CHECKPOINT_AT });
    await syncRunRepo.updatePhase(SYNC_RUN_ID, "PERSISTING_HISTORY", ["CREATED", "FETCHING_SNAPSHOT", "PERSISTING_SNAPSHOTS", "PERSISTING_INCIDENTS", "PERSISTING_HISTORY"]);

    const service = new SyncService(syncRunRepo, null, new MockIncidentRepository(), null, null, null, null, null, null, null, null, null, observationRepo);

    // Attempt 2: replaces S1 (5 rows) with S2 (3 rows)
    const result = await service.runSync({ checkpointAt: CHECKPOINT_AT });
    expect(result.ok).toBe(true);
    expect(await observationRepo.countPersisted(SYNC_RUN_ID, "RILLNET")).toBe(3);
    expect(dbObservations.has("ORD-4")).toBe(false);
    expect(dbObservations.has("ORD-5")).toBe(false);

    // Attempt 3 (Idempotent Retry with same S2): remains exactly 3 rows
    // Mark manifest FAILED to simulate retry of incomplete run
    manifestRecord!.population_status = "FAILED";
    const retryResult = await service.runSync({ checkpointAt: CHECKPOINT_AT });
    expect(retryResult.ok).toBe(true);
    expect(await observationRepo.countPersisted(SYNC_RUN_ID, "RILLNET")).toBe(3);
  });

  it("fail-closed: aborts and throws INBOUND_POPULATION_REPLACEMENT_FAILED when cleanup fails without corrupting table with union", async () => {
    const CHECKPOINT_AT = "2026-09-26T01:00:00.000Z";
    const SYNC_RUN_ID = "00000000-0000-4000-8000-000000000003";

    const dbObservations = new Map<string, InboundOrderObservationRow>();
    dbObservations.set("STALE-1", {
      sync_run_id: SYNC_RUN_ID,
      source_system: "RILLNET",
      order_code: "STALE-1",
      current_warehouse_id: "WH-1",
      deliver_warehouse_id: "WH-2",
      source_status: "storing",
      end_pick_at: null,
      weight_kg: 1.0,
      is_b2b: false,
      source_observed_at: "2026-09-26T01:00:00.000Z",
    });

    const observationRepo: IInboundOrderObservationRepository = {
      async getPopulationManifest() {
        return {
          sync_run_id: SYNC_RUN_ID,
          source_system: "RILLNET",
          population_status: "FAILED",
          normalized_population_count: 1,
          expected_observation_count: 1,
          persisted_observation_count: 0,
          duplicate_identical_count: 0,
          duplicate_conflict_count: 0,
          source_freshness: "2026-09-26T01:00:00.000Z",
        };
      },
      async replaceIncompletePopulation() {
        // Simulates failed cleanup where residual observations remain
        throw new Error("INBOUND_POPULATION_REPLACEMENT_FAILED: residual observations remain after cleanup (1 rows)");
      },
      async insertBatch() {
        throw new Error("insertBatch must not be called when replacement cleanup fails");
      },
      async countPersisted() { return dbObservations.size; },
      async completePopulation() {},
      async failPopulation() {},
    };

    vi.spyOn(RillnetConnector.prototype, "fetchSnapshotUrlOnly").mockResolvedValue({ downloadUrl: "https://example.test/s2.gz", updatedAt: "2026-09-26T03:00:00.000Z" });
    vi.spyOn(RillnetConnector.prototype, "downloadBufferOnly").mockResolvedValue(new ArrayBuffer(0));
    vi.spyOn(RillnetConnector.prototype, "parseSnapshotFromBuffer").mockResolvedValue({
      totalOrders: 1,
      fetchedAt: "2026-09-26T03:00:00.000Z",
      orders: [{ orderCode: "NEW-1", status: "storing" }],
    } as any);

    const syncRunRepo = new MockSyncRunRepository();
    await syncRunRepo.createSyncRun("2026-09-26T01:00:00.000Z", { id: SYNC_RUN_ID, checkpointAt: CHECKPOINT_AT });

    const service = new SyncService(syncRunRepo, null, new MockIncidentRepository(), null, null, null, null, null, null, null, null, null, observationRepo);

    const result = await service.runSync({ checkpointAt: CHECKPOINT_AT });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("INBOUND_POPULATION_REPLACEMENT_FAILED");
    // Database remained protected from union corruption
    expect(dbObservations.size).toBe(1);
    expect(dbObservations.has("NEW-1")).toBe(false);
  });
});
