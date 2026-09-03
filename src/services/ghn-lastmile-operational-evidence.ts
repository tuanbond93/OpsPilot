import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlannerOperationalEvidence } from "@/agents/action-planner/evidence-builder";
import { createAdminClient } from "@/connectors/supabase/server";

const MAX_SNAPSHOT_AGE_MS = 30 * 60 * 1000;

type SnapshotRow = {
  hub_id: unknown;
  source_fetched_at: unknown;
  staffing: unknown;
  workload: unknown;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const nonNegativeInteger = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

const iso = (value: unknown): string | null => {
  const parsed = typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
  return parsed;
};

const fresh = (value: string, referenceTimeMs: number) => {
  const fetchedAt = Date.parse(value);
  return fetchedAt <= referenceTimeMs && referenceTimeMs - fetchedAt <= MAX_SNAPSHOT_AGE_MS;
};

/**
 * Validates the database projection before it reaches the planner. The
 * incident warehouse ID is deliberately compared directly with the GHN hub
 * ID: no guessed cross-system mapping is permitted.
 */
export function parseLatestOperationalEvidence(
  row: SnapshotRow | null | undefined,
  warehouseId: string,
  referenceTimeMs: number = Date.now()
): PlannerOperationalEvidence | null {
  if (!row || typeof row.hub_id !== "string" || row.hub_id !== warehouseId) return null;
  const fetchedAt = iso(row.source_fetched_at);
  if (!fetchedAt || !fresh(fetchedAt, referenceTimeMs)) return null;

  const staffing = record(row.staffing);
  const workload = record(row.workload);
  if (!staffing || !workload || staffing.hubId !== row.hub_id || workload.hubId !== row.hub_id) return null;

  const staffingValues = [
    nonNegativeInteger(staffing.scheduledForDayCount),
    nonNegativeInteger(staffing.currentlyScheduledWorkforceCount),
    nonNegativeInteger(staffing.onLeaveCount),
    nonNegativeInteger(staffing.activeDriverCount),
    nonNegativeInteger(staffing.scheduledActiveDriverCount),
    nonNegativeInteger(staffing.unscheduledActiveDriverCount),
  ];
  const workloadValues = [
    nonNegativeInteger(workload.activeTripCount),
    nonNegativeInteger(workload.activeDriverCount),
    nonNegativeInteger(workload.assignedDeliveryCount),
    nonNegativeInteger(workload.successfulDeliveryCount),
    nonNegativeInteger(workload.pendingDeliveryCount),
    nonNegativeInteger(workload.returnCount),
    nonNegativeInteger(workload.cancelledCount),
  ];
  if (staffingValues.some((value) => value === null) || workloadValues.some((value) => value === null) || typeof staffing.scheduleDate !== "string") return null;

  return {
    warehouseId,
    ghnHubId: row.hub_id,
    staffing: {
      hubId: row.hub_id,
      scheduleDate: staffing.scheduleDate,
      scheduledForDayCount: staffingValues[0]!,
      currentlyScheduledWorkforceCount: staffingValues[1]!,
      onLeaveCount: staffingValues[2]!,
      activeDriverCount: staffingValues[3]!,
      scheduledActiveDriverCount: staffingValues[4]!,
      unscheduledActiveDriverCount: staffingValues[5]!,
      sourceFetchedAt: fetchedAt,
    },
    workload: {
      hubId: row.hub_id,
      activeTripCount: workloadValues[0]!,
      activeDriverCount: workloadValues[1]!,
      assignedDeliveryCount: workloadValues[2]!,
      successfulDeliveryCount: workloadValues[3]!,
      pendingDeliveryCount: workloadValues[4]!,
      returnCount: workloadValues[5]!,
      cancelledCount: workloadValues[6]!,
      latestSourceUpdatedAt: iso(workload.latestSourceUpdatedAt),
      sourceFetchedAt: fetchedAt,
    },
  };
}

export async function loadLatestOperationalEvidence(
  warehouseId: string,
  options: { client?: SupabaseClient; referenceTimeMs?: number } = {}
): Promise<PlannerOperationalEvidence | null> {
  if (!/^\d{5,20}$/.test(warehouseId)) return null;
  const db = options.client || createAdminClient();
  const { data, error } = await db
    .from("ghn_lastmile_operational_snapshots")
    .select("hub_id, source_fetched_at, staffing, workload")
    .eq("hub_id", warehouseId)
    .order("source_fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`GHN_OPERATIONAL_SNAPSHOT_READ_FAILED:${error.message}`);
  return parseLatestOperationalEvidence(data as SnapshotRow | null, warehouseId, options.referenceTimeMs);
}
