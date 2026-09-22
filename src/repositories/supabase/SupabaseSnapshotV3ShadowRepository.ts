import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrderSnapshotRow } from "@/connectors/supabase/types";
import {
  calculateSnapshotV3AgeHours,
  computeOrderMaterialHash,
  computeOrderMaterialState,
} from "@/domain/snapshot-v3/material-state";
import type { SnapshotV3Comparison } from "@/domain/snapshot-v3/comparator";
import type {
  ISnapshotV3ShadowRepository,
  SnapshotV3ShadowWriteResult,
  SnapshotV3StorageTelemetry,
} from "../interfaces/ISnapshotV3ShadowRepository";

type StateVersionRecord = {
  state_version_id: string;
  order_code: string;
  material_hash: string;
  material_state: Record<string, unknown>;
};

const chunks = <T>(values: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
};

export class SupabaseSnapshotV3ShadowRepository implements ISnapshotV3ShadowRepository {
  constructor(private readonly client: SupabaseClient) {}

  async writeBatch(
    syncRunId: string,
    rows: OrderSnapshotRow[],
    evaluationReferenceAt: string,
    batchSize = 500
  ): Promise<SnapshotV3ShadowWriteResult> {
    const sourceUpdatedAt = rows.find((row) => row.source_updated_at)?.source_updated_at || null;
    const { error: syncRunError } = await this.client
      .from("shadow_sync_runs")
      .upsert({
        sync_run_id: syncRunId,
        source_updated_at: sourceUpdatedAt,
        evaluation_reference_at: evaluationReferenceAt,
        status: "COMPLETED",
        observed_at: new Date().toISOString(),
      }, { onConflict: "sync_run_id" });
    if (syncRunError) throw new Error(`SnapshotV3 shadow run metadata write failed: ${syncRunError.message}`);

    if (rows.length === 0) return { stateVersionRows: 0, referenceRows: 0, reusedStateVersions: 0 };

    const stateByKey = new Map<string, { order_code: string; material_hash: string; material_state: Record<string, unknown>; valid_from: string }>();
    for (const row of rows) {
      const state = computeOrderMaterialState(row);
      const materialHash = computeOrderMaterialHash(state);
      const key = `${row.order_code}\u001f${materialHash}`;
      stateByKey.set(key, {
        order_code: row.order_code,
        material_hash: materialHash,
        material_state: state as unknown as Record<string, unknown>,
        valid_from: evaluationReferenceAt,
      });
    }

    for (const batch of chunks([...stateByKey.values()], batchSize)) {
      const { error } = await this.client
        .from("order_state_versions")
        .upsert(batch, { onConflict: "order_code,material_hash", ignoreDuplicates: true });
      if (error) throw new Error(`SnapshotV3 state version write failed: ${error.message}`);
    }

    const orderCodes = [...new Set(rows.map((row) => row.order_code))];
    const { data: stateVersions, error: stateError } = await this.client
      .from("order_state_versions")
      .select("state_version_id,order_code,material_hash,material_state")
      .in("order_code", orderCodes);
    if (stateError) throw new Error(`SnapshotV3 state version lookup failed: ${stateError.message}`);

    const stateByKeyFromDb = new Map(
      ((stateVersions || []) as StateVersionRecord[]).map((state) => [
        `${state.order_code}\u001f${state.material_hash}`,
        state,
      ])
    );
    const refs = rows.map((row) => {
      const state = computeOrderMaterialState(row);
      const materialHash = computeOrderMaterialHash(state);
      const version = stateByKeyFromDb.get(`${row.order_code}\u001f${materialHash}`);
      if (!version) throw new Error(`SnapshotV3 state version missing for ${row.order_code}`);
      return {
        sync_run_id: syncRunId,
        order_code: row.order_code,
        state_version_id: version.state_version_id,
        warehouse_id: row.warehouse_id || "",
        source_status: row.source_status,
        reason_code: row.reason_code || null,
        evaluation_reference_at: evaluationReferenceAt,
      };
    });

    for (const batch of chunks(refs, batchSize)) {
      const { error } = await this.client
        .from("sync_run_order_refs")
        .upsert(batch, {
          onConflict: "sync_run_id,order_code,warehouse_id,source_status",
          ignoreDuplicates: false,
        });
      if (error) throw new Error(`SnapshotV3 reference write failed: ${error.message}`);
    }

    return {
      stateVersionRows: stateByKey.size,
      referenceRows: refs.length,
      reusedStateVersions: Math.max(0, rows.length - stateByKey.size),
    };
  }

  async reconstructSyncRun(syncRunId: string): Promise<OrderSnapshotRow[]> {
    const { data: refs, error: refsError } = await this.client
      .from("sync_run_order_refs")
      .select("sync_run_id,order_code,state_version_id,reason_code,evaluation_reference_at")
      .eq("sync_run_id", syncRunId);
    if (refsError) throw new Error(`SnapshotV3 reference read failed: ${refsError.message}`);
    if (!refs || refs.length === 0) return [];

    const stateIds = [...new Set(refs.map((ref: any) => ref.state_version_id))];
    const [{ data: states, error: statesError }, { data: syncRun, error: syncRunMetadataError }] = await Promise.all([
      this.client.from("order_state_versions").select("state_version_id,order_code,material_state").in("state_version_id", stateIds),
      this.client.from("shadow_sync_runs").select("source_updated_at,status").eq("sync_run_id", syncRunId).maybeSingle(),
    ]);
    if (statesError) throw new Error(`SnapshotV3 state version read failed: ${statesError.message}`);
    if (syncRunMetadataError) throw new Error(`SnapshotV3 shadow run metadata read failed: ${syncRunMetadataError.message}`);

    const statesById = new Map((states || []).map((state: any) => [state.state_version_id, state]));
    return refs.map((ref: any) => {
      const state = statesById.get(ref.state_version_id);
      if (!state) throw new Error(`SnapshotV3 missing state version ${ref.state_version_id}`);
      const material = state.material_state as Record<string, any>;
      const ageHours = calculateSnapshotV3AgeHours(material.order_created_at, ref.evaluation_reference_at);
      return {
        sync_run_id: syncRunId,
        order_code: ref.order_code,
        warehouse_id: material.warehouse_id,
        warehouse_name: material.warehouse_name,
        source_status: material.source_status,
        task_category: material.task_category,
        reason_code: ref.reason_code,
        order_created_at: material.order_created_at,
        source_updated_at: syncRun?.source_updated_at || null,
        age_hours: ageHours,
        pick_warehouse_id: material.pick_warehouse_id,
        deliver_warehouse_id: material.deliver_warehouse_id,
        deliver_warehouse_name: material.deliver_warehouse_name,
        destination_province_id: material.destination_province_id,
        destination_district_id: material.destination_district_id,
        weight_grams: material.weight_grams,
        weight_kg: material.weight_grams === null || material.weight_grams === undefined ? null : Number(material.weight_grams) / 1000,
        sort_code: material.sort_code,
        is_b2b: material.is_b2b,
        service_type_id: material.service_type_id,
        end_pick_at: material.end_pick_at,
        end_delivery_at: material.end_delivery_at,
        end_success_at: material.end_success_at,
        warehouse_log: material.warehouse_log,
      } satisfies OrderSnapshotRow;
    });
  }

  async recordComparison(syncRunId: string, comparison: SnapshotV3Comparison): Promise<void> {
    const { error } = await this.client
      .from("snapshot_v3_shadow_comparisons")
      .upsert({
        sync_run_id: syncRunId,
        legacy_row_count: comparison.legacyRowCount,
        v3_row_count: comparison.v3RowCount,
        cohort_count_match: comparison.cohortCountMatch,
        order_set_match: comparison.orderSetMatch,
        identity_set_match: comparison.identitySetMatch,
        material_state_match: comparison.materialStateMatch,
        age_match: comparison.ageMatch,
        journey_match: comparison.journeyMatch,
        reason_code_match: comparison.reasonCodeMatch,
        source_freshness_match: comparison.sourceFreshnessMatch,
        mismatch_count: comparison.mismatchCount,
        comparison_status: comparison.mismatchCount === 0 ? "MATCH" : "MISMATCH",
      }, { onConflict: "sync_run_id" });
    if (error) throw new Error(`SnapshotV3 comparison write failed: ${error.message}`);
  }

  async getStorageTelemetry(): Promise<SnapshotV3StorageTelemetry> {
    const { data, error } = await (this.client as any).rpc("snapshot_v3_storage_telemetry");
    if (error) throw new Error(`SnapshotV3 storage telemetry failed: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    return {
      stateVersionRows: Number(row?.state_version_rows || 0),
      stateVersionAvgBytes: row?.state_version_avg_bytes == null ? null : Number(row.state_version_avg_bytes),
      referenceRows: Number(row?.reference_rows || 0),
      referenceAvgBytes: row?.reference_avg_bytes == null ? null : Number(row.reference_avg_bytes),
      stateVersionBytesTotal: Number(row?.state_version_bytes_total || 0),
      referenceBytesTotal: Number(row?.reference_bytes_total || 0),
      legacyEquivalentBytes: row?.legacy_equivalent_bytes == null ? null : Number(row.legacy_equivalent_bytes),
      actualStorageReductionPct: row?.actual_storage_reduction_pct == null ? null : Number(row.actual_storage_reduction_pct),
    };
  }
}
