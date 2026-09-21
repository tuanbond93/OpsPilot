import type { OrderSnapshotRow } from "@/connectors/supabase/types";
import {
  computeOrderMaterialHash,
  computeOrderMaterialState,
  legacySnapshotIdentity,
} from "./material-state";

export type SnapshotV3Comparison = {
  legacyRowCount: number;
  v3RowCount: number;
  cohortCountMatch: boolean;
  orderSetMatch: boolean;
  identitySetMatch: boolean;
  materialStateMatch: boolean;
  ageMatch: boolean;
  journeyMatch: boolean;
  reasonCodeMatch: boolean;
  sourceFreshnessMatch: boolean;
  mismatchCount: number;
};

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

function mapsEqual(left: Map<string, number>, right: Map<string, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}

function rowByIdentity(rows: OrderSnapshotRow[]): Map<string, OrderSnapshotRow> {
  return new Map(rows.map((row) => [legacySnapshotIdentity(row), row]));
}

function sameNullableNumber(left: number | null | undefined, right: number | null | undefined): boolean {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return Number(left) === Number(right);
}

function sameJourney(left: OrderSnapshotRow, right: OrderSnapshotRow): boolean {
  return JSON.stringify(computeOrderMaterialState(left).warehouse_log)
    === JSON.stringify(computeOrderMaterialState(right).warehouse_log);
}

export function compareSnapshotV3Cohort(
  legacyRows: OrderSnapshotRow[],
  reconstructedRows: OrderSnapshotRow[]
): SnapshotV3Comparison {
  const legacyIdentities = legacyRows.map(legacySnapshotIdentity);
  const v3Identities = reconstructedRows.map(legacySnapshotIdentity);
  const legacyOrderCodes = countValues(legacyRows.map((row) => row.order_code));
  const v3OrderCodes = countValues(reconstructedRows.map((row) => row.order_code));
  const legacyIdentityCounts = countValues(legacyIdentities);
  const v3IdentityCounts = countValues(v3Identities);
  const legacyByIdentity = rowByIdentity(legacyRows);
  const v3ByIdentity = rowByIdentity(reconstructedRows);

  let materialStateMatch = true;
  let ageMatch = true;
  let journeyMatch = true;
  let reasonCodeMatch = true;
  let sourceFreshnessMatch = true;
  let rowMismatches = 0;

  for (const [identity, legacyRow] of legacyByIdentity) {
    const reconstructed = v3ByIdentity.get(identity);
    if (!reconstructed) {
      rowMismatches++;
      continue;
    }

    if (computeOrderMaterialHash(computeOrderMaterialState(legacyRow)) !== computeOrderMaterialHash(computeOrderMaterialState(reconstructed))) {
      materialStateMatch = false;
      rowMismatches++;
    }
    if (!sameNullableNumber(legacyRow.age_hours, reconstructed.age_hours)) ageMatch = false;
    if (!sameJourney(legacyRow, reconstructed)) journeyMatch = false;
    if ((legacyRow.reason_code || null) !== (reconstructed.reason_code || null)) reasonCodeMatch = false;
    if ((legacyRow.source_updated_at || null) !== (reconstructed.source_updated_at || null)) sourceFreshnessMatch = false;
  }

  const cohortCountMatch = legacyRows.length === reconstructedRows.length;
  const orderSetMatch = mapsEqual(legacyOrderCodes, v3OrderCodes);
  const identitySetMatch = mapsEqual(legacyIdentityCounts, v3IdentityCounts);
  const mismatchCount = rowMismatches
    + (cohortCountMatch ? 0 : 1)
    + (orderSetMatch ? 0 : 1)
    + (identitySetMatch ? 0 : 1)
    + (ageMatch ? 0 : 1)
    + (journeyMatch ? 0 : 1)
    + (reasonCodeMatch ? 0 : 1)
    + (sourceFreshnessMatch ? 0 : 1);

  return {
    legacyRowCount: legacyRows.length,
    v3RowCount: reconstructedRows.length,
    cohortCountMatch,
    orderSetMatch,
    identitySetMatch,
    materialStateMatch,
    ageMatch,
    journeyMatch,
    reasonCodeMatch,
    sourceFreshnessMatch,
    mismatchCount,
  };
}
