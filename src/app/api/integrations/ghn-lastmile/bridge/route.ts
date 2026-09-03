import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { authorizeApiRequest, readJsonBody } from "@/security/api-security";

export const dynamic = "force-dynamic";

const count = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1_000_000, Math.trunc(Number(value)))) : 0;
const iso = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
const hub = (value: unknown) => typeof value === "string" && /^[0-9]{5,20}$/.test(value) ? value : null;

function sanitizeSnapshot(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>; const hubId = hub(value.hubId); const fetchedAt = iso(value.sourceFetchedAt);
  const staffing = value.staffing as Record<string, unknown> | null; const workload = value.workload as Record<string, unknown> | null;
  if (!hubId || !fetchedAt || !staffing || !workload || hub(staffing.hubId) !== hubId || hub(workload.hubId) !== hubId) return null;
  return {
    hub_id: hubId, source_fetched_at: fetchedAt,
    staffing: { hubId, scheduleDate: typeof staffing.scheduleDate === "string" ? staffing.scheduleDate.slice(0, 10) : null, scheduledForDayCount: count(staffing.scheduledForDayCount), currentlyScheduledWorkforceCount: count(staffing.currentlyScheduledWorkforceCount), onLeaveCount: count(staffing.onLeaveCount), activeDriverCount: count(staffing.activeDriverCount), scheduledActiveDriverCount: count(staffing.scheduledActiveDriverCount), unscheduledActiveDriverCount: count(staffing.unscheduledActiveDriverCount), sourceFetchedAt: fetchedAt },
    workload: { hubId, activeTripCount: count(workload.activeTripCount), activeDriverCount: count(workload.activeDriverCount), assignedDeliveryCount: count(workload.assignedDeliveryCount), successfulDeliveryCount: count(workload.successfulDeliveryCount), pendingDeliveryCount: count(workload.pendingDeliveryCount), returnCount: count(workload.returnCount), cancelledCount: count(workload.cancelledCount), latestSourceUpdatedAt: iso(workload.latestSourceUpdatedAt), sourceFetchedAt: fetchedAt },
  };
}

export async function POST(request: NextRequest) {
  const parsed = await readJsonBody(request, 32_768); if (!parsed.ok) return parsed.response;
  const access = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 12, windowMs: 60_000 }); if (!access.ok) return access.response;
  const source = parsed.body.source === "ghn_tampermonkey_lastmile" ? parsed.body.source : null;
  const raw = Array.isArray(parsed.body.snapshots) ? parsed.body.snapshots.slice(0, 12) : [];
  if (!source || !raw.length) return NextResponse.json({ error: "INVALID_SNAPSHOT_BATCH" }, { status: 400 });
  const rows = raw.map(sanitizeSnapshot).filter((row): row is NonNullable<typeof row> => Boolean(row)).map((row) => ({ ...row, source }));
  if (!rows.length) return NextResponse.json({ error: "NO_VALID_SNAPSHOTS" }, { status: 400 });
  try {
    const db = createAdminClient(); const { error } = await db.from("ghn_lastmile_operational_snapshots").insert(rows);
    if (error) throw error;
    return NextResponse.json({ ok: true, stored: rows.length });
  } catch (error: unknown) {
    return NextResponse.json({ error: "SNAPSHOT_STORE_FAILED", message: error instanceof Error ? error.message : "Unknown error" }, { status: 503 });
  }
}
