import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderSnapshotRow } from "@/connectors/supabase/types";
import {
  calculateSnapshotV3AgeHours,
  computeOrderMaterialHash,
  computeOrderMaterialState,
  legacySnapshotIdentity,
} from "@/domain/snapshot-v3/material-state";
import { compareSnapshotV3Cohort } from "@/domain/snapshot-v3/comparator";
import type { ISnapshotV3ShadowRepository, SnapshotV3ShadowWriteResult } from "@/repositories/interfaces/ISnapshotV3ShadowRepository";
import { persistLegacyThenSnapshotV3Shadow, runSnapshotV3Shadow } from "@/services/snapshot-v3-shadow";

type MemoryState = ReturnType<typeof computeOrderMaterialState>;

function row(overrides: Partial<OrderSnapshotRow> = {}): OrderSnapshotRow {
  return {
    sync_run_id: "run-1",
    order_code: "ORDER-1",
    warehouse_id: "WH-1",
    warehouse_name: "Warehouse 1",
    source_status: "storing",
    task_category: "Tồn KCT/KTC",
    reason_code: "KHO_TON",
    order_created_at: "2026-09-20T00:00:00.000Z",
    source_updated_at: "2026-09-21T00:00:00.000Z",
    age_hours: 24,
    pick_warehouse_id: "PICK-1",
    deliver_warehouse_id: "DELIVER-1",
    deliver_warehouse_name: "Delivery 1",
    destination_province_id: "79",
    destination_district_id: "145",
    weight_grams: 233556,
    weight_kg: 233.556,
    sort_code: "A1",
    is_b2b: true,
    service_type_id: "SERVICE-1",
    end_pick_at: null,
    end_delivery_at: null,
    end_success_at: null,
    warehouse_log: [{ warehouse_id: "WH-1", updated_date: "2026-09-20T01:00:00.000Z" }],
    ...overrides,
  };
}

class MemoryShadowRepository implements ISnapshotV3ShadowRepository {
  states = new Map<string, { id: string; orderCode: string; hash: string; state: MemoryState }>();
  refs = new Map<string, { syncRunId: string; orderCode: string; stateId: string; warehouseId: string; sourceStatus: string; reasonCode: string | null; evaluationReferenceAt: string }>();
  sourceFreshness = new Map<string, string | null>();
  writes = 0;

  async writeBatch(syncRunId: string, rows: OrderSnapshotRow[], evaluationReferenceAt: string): Promise<SnapshotV3ShadowWriteResult> {
    this.writes++;
    for (const current of rows) {
      const state = computeOrderMaterialState(current);
      const hash = computeOrderMaterialHash(state);
      const key = `${current.order_code}:${hash}`;
      if (!this.states.has(key)) this.states.set(key, { id: `state-${this.states.size + 1}`, orderCode: current.order_code, hash, state });
      const stateVersion = this.states.get(key)!;
      const refKey = `${syncRunId}:${current.order_code}:${current.warehouse_id || ""}:${current.source_status}`;
      this.refs.set(refKey, {
        syncRunId,
        orderCode: current.order_code,
        stateId: stateVersion.id,
        warehouseId: current.warehouse_id || "",
        sourceStatus: current.source_status,
        reasonCode: current.reason_code || null,
        evaluationReferenceAt,
      });
      this.sourceFreshness.set(syncRunId, current.source_updated_at || null);
    }
    return { stateVersionRows: rows.length, referenceRows: rows.length, reusedStateVersions: 0 };
  }

  async reconstructSyncRun(syncRunId: string): Promise<OrderSnapshotRow[]> {
    return [...this.refs.values()]
      .filter((ref) => ref.syncRunId === syncRunId)
      .map((ref) => {
        const version = [...this.states.values()].find((state) => state.id === ref.stateId)!;
        const state = version.state;
        const age = calculateSnapshotV3AgeHours(state.order_created_at, ref.evaluationReferenceAt);
        return {
          sync_run_id: syncRunId,
          order_code: ref.orderCode,
          warehouse_id: state.warehouse_id,
          warehouse_name: state.warehouse_name,
          source_status: state.source_status,
          task_category: state.task_category,
          reason_code: ref.reasonCode,
          order_created_at: state.order_created_at,
          source_updated_at: this.sourceFreshness.get(syncRunId) || null,
          age_hours: age,
          pick_warehouse_id: state.pick_warehouse_id,
          deliver_warehouse_id: state.deliver_warehouse_id,
          deliver_warehouse_name: state.deliver_warehouse_name,
          destination_province_id: state.destination_province_id,
          destination_district_id: state.destination_district_id,
          weight_grams: state.weight_grams,
          weight_kg: state.weight_grams === null ? null : state.weight_grams / 1000,
          sort_code: state.sort_code,
          is_b2b: state.is_b2b,
          service_type_id: state.service_type_id,
          end_pick_at: state.end_pick_at,
          end_delivery_at: state.end_delivery_at,
          end_success_at: state.end_success_at,
          warehouse_log: state.warehouse_log,
        };
      });
  }
}

describe("Snapshot Storage V3 shadow", () => {
  beforeEach(() => {
    vi.stubEnv("SNAPSHOT_V3_SHADOW_ENABLED", "false");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("produces a deterministic hash and excludes technical/classification fields", () => {
    const first = row({ id: 1, created_at: "2026-09-21T01:00:00.000Z", age_hours: 24, reason_code: "KHO_TON", source_updated_at: "2026-09-21T00:00:00.000Z" });
    const second = row({ id: 999, created_at: "2026-09-21T02:00:00.000Z", age_hours: 30, reason_code: "KHO_CHUA_LUAN_CHUYEN", source_updated_at: "2026-09-22T00:00:00.000Z" });
    expect(computeOrderMaterialHash(computeOrderMaterialState(first))).toBe(computeOrderMaterialHash(computeOrderMaterialState(second)));
  });

  it("reuses unchanged state, creates a changed version, and keeps reason on each reference", async () => {
    const repository = new MemoryShadowRepository();
    vi.stubEnv("SNAPSHOT_V3_SHADOW_ENABLED", "true");
    const first = row({ sync_run_id: "run-1", reason_code: "KHO_TON" });
    const second = row({ sync_run_id: "run-2", reason_code: "KHO_CHUA_LUAN_CHUYEN", age_hours: 30 });
    await runSnapshotV3Shadow({ shadowRepository: repository, syncRunId: "run-1", rows: [first], evaluationReferenceAt: "2026-09-21T00:00:00.000Z" });
    await runSnapshotV3Shadow({ shadowRepository: repository, syncRunId: "run-2", rows: [second], evaluationReferenceAt: "2026-09-22T00:00:00.000Z" });
    expect(repository.states.size).toBe(1);
    expect(repository.refs.size).toBe(2);
    expect((await repository.reconstructSyncRun("run-2"))[0].reason_code).toBe("KHO_CHUA_LUAN_CHUYEN");

    const changed = row({ sync_run_id: "run-3", source_status: "transporting", task_category: "Luân chuyển", reason_code: "KHO_CHUA_LUAN_CHUYEN" });
    await runSnapshotV3Shadow({ shadowRepository: repository, syncRunId: "run-3", rows: [changed], evaluationReferenceAt: "2026-09-23T00:00:00.000Z" });
    expect(repository.states.size).toBe(2);
  });

  it("is idempotent for a retry of the same run", async () => {
    const repository = new MemoryShadowRepository();
    vi.stubEnv("SNAPSHOT_V3_SHADOW_ENABLED", "true");
    const current = row();
    await runSnapshotV3Shadow({ shadowRepository: repository, syncRunId: "run-1", rows: [current], evaluationReferenceAt: "2026-09-21T00:00:00.000Z" });
    await runSnapshotV3Shadow({ shadowRepository: repository, syncRunId: "run-1", rows: [current], evaluationReferenceAt: "2026-09-21T00:00:00.000Z" });
    expect(repository.states.size).toBe(1);
    expect(repository.refs.size).toBe(1);
  });

  it("reconstructs age and preserves warehouse journey evidence", async () => {
    const repository = new MemoryShadowRepository();
    vi.stubEnv("SNAPSHOT_V3_SHADOW_ENABLED", "true");
    const current = row({ order_created_at: "2026-09-20T06:00:00.000Z", warehouse_log: [{ warehouse_id: "WH-1", time: "2026-09-20T07:00:00.000Z" }] });
    const result = await runSnapshotV3Shadow({ shadowRepository: repository, syncRunId: "run-1", rows: [current], evaluationReferenceAt: "2026-09-21T06:00:00.000Z" });
    expect(result.comparison?.ageMatch).toBe(true);
    expect(result.comparison?.journeyMatch).toBe(true);
    expect((await repository.reconstructSyncRun("run-1"))[0].age_hours).toBe(24);
    expect((await repository.reconstructSyncRun("run-1"))[0].warehouse_log).toEqual(current.warehouse_log);
  });

  it("does not create a V3 write when legacy persistence fails", async () => {
    vi.stubEnv("SNAPSHOT_V3_SHADOW_ENABLED", "true");
    const writeBatch = vi.fn();
    await expect(persistLegacyThenSnapshotV3Shadow({
      legacyInsert: async () => { throw new Error("LEGACY_WRITE_FAILED"); },
      shadowRepository: { writeBatch, reconstructSyncRun: vi.fn() },
      syncRunId: "run-1",
      rows: [row()],
      evaluationReferenceAt: "2026-09-21T00:00:00.000Z",
    })).rejects.toThrow("LEGACY_WRITE_FAILED");
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it("keeps legacy success when the V3 shadow write fails", async () => {
    vi.stubEnv("SNAPSHOT_V3_SHADOW_ENABLED", "true");
    const result = await persistLegacyThenSnapshotV3Shadow({
      legacyInsert: async () => 1,
      shadowRepository: { writeBatch: vi.fn().mockRejectedValue(new Error("SHADOW_WRITE_FAILED")), reconstructSyncRun: vi.fn() },
      syncRunId: "run-1",
      rows: [row()],
      evaluationReferenceAt: "2026-09-21T00:00:00.000Z",
    });
    expect(result.legacyRows).toBe(1);
    expect(result.shadowStatus).toBe("FAILED");
    expect(result.error).toContain("SHADOW_WRITE_FAILED");
  });

  it("fails closed on duplicate or conflicting legacy identity", () => {
    const first = row();
    const duplicate = row({ weight_grams: 999, weight_kg: 0.999 });
    const reconstructed = [first];
    const comparison = compareSnapshotV3Cohort([first, duplicate], reconstructed);
    expect(comparison.identitySetMatch).toBe(false);
    expect(comparison.cohortCountMatch).toBe(false);
    expect(comparison.mismatchCount).toBeGreaterThan(0);
    expect(legacySnapshotIdentity(first)).toBe(legacySnapshotIdentity(duplicate));
  });

  it("does not expose a disabled shadow path", async () => {
    const writeBatch = vi.fn();
    const result = await runSnapshotV3Shadow({
      shadowRepository: { writeBatch, reconstructSyncRun: vi.fn() },
      syncRunId: "run-1",
      rows: [row()],
      evaluationReferenceAt: "2026-09-21T00:00:00.000Z",
    });
    expect(result.shadowStatus).toBe("DISABLED");
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it("does not construct a secondary client while the flag is disabled", async () => {
    vi.stubEnv("SNAPSHOT_V3_SHADOW_ENABLED", "false");
    vi.stubEnv("SNAPSHOT_V3_SUPABASE_URL", "https://shadow.example.supabase.co");
    vi.stubEnv("SNAPSHOT_V3_SUPABASE_SERVICE_ROLE_KEY", "shadow-secret");

    const { createSnapshotV3ShadowClient } = await import("@/connectors/supabase/snapshot-v3-server");
    expect(createSnapshotV3ShadowClient()).toBeNull();
  });

  it("requires dedicated shadow credentials and rejects the primary project", async () => {
    vi.stubEnv("SNAPSHOT_V3_SHADOW_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://primary.example.supabase.co");
    vi.stubEnv("SNAPSHOT_V3_SUPABASE_URL", "https://primary.example.supabase.co");
    vi.stubEnv("SNAPSHOT_V3_SUPABASE_SERVICE_ROLE_KEY", "shadow-secret");

    const { createSnapshotV3ShadowClient } = await import("@/connectors/supabase/snapshot-v3-server");
    expect(createSnapshotV3ShadowClient()).toBeNull();
  });
});
