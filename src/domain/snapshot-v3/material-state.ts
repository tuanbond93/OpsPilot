import { createHash } from "node:crypto";
import type { OrderSnapshotRow } from "@/connectors/supabase/types";

/**
 * warehouse_log is intentionally retained in the shadow material state.
 * The source mapper supplies journey evidence, while the live-status route
 * can append a cache marker to the same JSON array. Until that mixed payload
 * is split into separate tables, dropping it would make shadow reconstruction
 * semantically lossy.
 */
export const SNAPSHOT_V3_MATERIAL_FIELDS = [
  "warehouse_id",
  "warehouse_name",
  "source_status",
  "task_category",
  "order_created_at",
  "pick_warehouse_id",
  "deliver_warehouse_id",
  "deliver_warehouse_name",
  "destination_province_id",
  "destination_district_id",
  "weight_grams",
  "sort_code",
  "is_b2b",
  "service_type_id",
  "end_pick_at",
  "end_delivery_at",
  "end_success_at",
  "warehouse_log",
] as const;

export type SnapshotV3MaterialState = {
  warehouse_id: string | null;
  warehouse_name: string | null;
  source_status: string;
  task_category: string | null;
  order_created_at: string | null;
  pick_warehouse_id: string | null;
  deliver_warehouse_id: string | null;
  deliver_warehouse_name: string | null;
  destination_province_id: string | null;
  destination_district_id: string | null;
  weight_grams: number | null;
  sort_code: string | null;
  is_b2b: boolean | null;
  service_type_id: string | null;
  end_pick_at: string | null;
  end_delivery_at: string | null;
  end_success_at: string | null;
  warehouse_log: unknown[];
};

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function canonicalTimestamp(value: unknown): string | null {
  const normalized = nullableString(value);
  if (!normalized) return null;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : normalized;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJson(item)])
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value ?? null;
}

function canonicalWarehouseLog(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map(canonicalJson) : [];
}

/**
 * Creates the stable material payload. Run metadata, classification metadata,
 * and database identity are intentionally excluded.
 */
export function computeOrderMaterialState(row: OrderSnapshotRow): SnapshotV3MaterialState {
  const weightGrams = finiteNumber(row.weight_grams) ?? (() => {
    const weightKg = finiteNumber(row.weight_kg);
    return weightKg === null ? null : weightKg * 1000;
  })();

  return {
    warehouse_id: nullableString(row.warehouse_id),
    warehouse_name: nullableString(row.warehouse_name),
    source_status: nullableString(row.source_status) || "",
    task_category: nullableString(row.task_category),
    order_created_at: canonicalTimestamp(row.order_created_at),
    pick_warehouse_id: nullableString(row.pick_warehouse_id),
    deliver_warehouse_id: nullableString(row.deliver_warehouse_id),
    deliver_warehouse_name: nullableString(row.deliver_warehouse_name),
    destination_province_id: nullableString(row.destination_province_id),
    destination_district_id: nullableString(row.destination_district_id),
    weight_grams: weightGrams,
    sort_code: nullableString(row.sort_code),
    is_b2b: row.is_b2b === null || row.is_b2b === undefined ? null : Boolean(row.is_b2b),
    service_type_id: nullableString(row.service_type_id),
    end_pick_at: canonicalTimestamp(row.end_pick_at),
    end_delivery_at: canonicalTimestamp(row.end_delivery_at),
    end_success_at: canonicalTimestamp(row.end_success_at),
    warehouse_log: canonicalWarehouseLog(row.warehouse_log),
  };
}

export function computeOrderMaterialHash(state: SnapshotV3MaterialState): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

export function calculateSnapshotV3AgeHours(
  orderCreatedAt: string | null | undefined,
  evaluationReferenceAt: string
): number | null {
  if (!orderCreatedAt) return null;
  const createdMs = Date.parse(orderCreatedAt);
  const referenceMs = Date.parse(evaluationReferenceAt);
  if (!Number.isFinite(createdMs) || !Number.isFinite(referenceMs)) return null;

  const rawAgeHours = Math.max(0, (referenceMs - createdMs) / 3_600_000);
  // SyncService omits age_hours when the unrounded rule age is exactly zero.
  if (rawAgeHours === 0) return null;
  return Math.round(rawAgeHours * 10) / 10;
}

export function legacySnapshotIdentity(row: Pick<OrderSnapshotRow, "sync_run_id" | "order_code" | "warehouse_id" | "source_status">): string {
  return [row.sync_run_id, row.order_code, row.warehouse_id ?? "", row.source_status].join("\u001f");
}
