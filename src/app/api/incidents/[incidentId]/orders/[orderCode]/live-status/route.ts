import { NextRequest, NextResponse } from "next/server";
import { GhnOrderTrackingClient, GhnTrackingError, parseLiveOrderTracking } from "@/connectors/ghn-order-tracking";
import { authorizeIncidentScope } from "@/security/scope-guard";
import type { LiveOrderTracking } from "@/connectors/ghn-order-tracking";

export const dynamic = "force-dynamic";

const ORDER_CODE_PATTERN = /^[A-Z0-9_-]{4,40}$/i;
const CACHE_MARKER = "__opspilot_live_tracking_v1";

async function resolveLinkedOrder(request: NextRequest, incidentId: string, orderCode: string) {
  const guard = await authorizeIncidentScope(request, incidentId, "VIEW_SYSTEM", { limit: 60, windowMs: 60_000 });
  if (!guard.ok) return guard;
  const { data: incident } = await guard.client.from("incidents").select("warehouse_id,reason_code").eq("id", guard.incident.id).maybeSingle();
  const { data: history } = await guard.client.from("incident_history").select("sync_run_id").eq("incident_id", guard.incident.id).order("recorded_at", { ascending: false }).limit(1).maybeSingle();
  if (!incident || !history?.sync_run_id) return { ok: false as const, response: NextResponse.json({ error: "INCIDENT_HISTORY_NOT_FOUND" }, { status: 404 }) };
  const { data: linkedOrder } = await guard.client.from("order_snapshots").select("id,order_code,warehouse_log").eq("sync_run_id", history.sync_run_id).eq("warehouse_id", incident.warehouse_id).eq("reason_code", incident.reason_code).eq("order_code", orderCode).maybeSingle();
  if (!linkedOrder) return { ok: false as const, response: NextResponse.json({ error: "ORDER_NOT_IN_INCIDENT" }, { status: 404 }) };
  return { ok: true as const, guard, linkedOrder };
}

async function cachedTracking(client: any, orderCode: string) {
  const { data } = await client.from("order_snapshots").select("warehouse_log,created_at").eq("order_code", orderCode).order("created_at", { ascending: false }).limit(30);
  for (const row of data || []) {
    const marker = Array.isArray(row.warehouse_log) ? [...row.warehouse_log].reverse().find((item: any) => item?.[CACHE_MARKER]) : null;
    if (marker?.tracking) return { ...marker.tracking, ok: true, source: "saved_bridge_tracking", savedAt: marker.saved_at || row.created_at };
  }
  return null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ incidentId: string; orderCode: string }> }) {
  const { incidentId, orderCode: rawOrderCode } = await params;
  const orderCode = decodeURIComponent(rawOrderCode).trim().toUpperCase();
  if (!ORDER_CODE_PATTERN.test(orderCode)) return NextResponse.json({ error: "INVALID_ORDER_CODE" }, { status: 400 });

  const linked = await resolveLinkedOrder(request, incidentId, orderCode);
  if (!linked.ok) return linked.response;

  const client = new GhnOrderTrackingClient();
  try {
    const entries = await client.fetchOrderLogs(orderCode);
    const warehouseIds = new Set<string>();
    for (const entry of entries) {
      for (const data of [entry.old_data, entry.new_data]) {
        if (!data) continue;
        for (const key of ["current_warehouse_id", "next_warehouse_id", "pick_warehouse_id", "deliver_warehouse_id", "return_warehouse_id"]) {
          const value = data[key];
          if (value != null && String(value).trim()) warehouseIds.add(String(value));
        }
      }
    }
    const warehouseNames = await client.fetchWarehouseNames([...warehouseIds]);
    const tracking = parseLiveOrderTracking(orderCode, entries, warehouseNames);
    return NextResponse.json({ ok: true, source: "ghn_internal_order_logs", ...tracking }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const cached = await cachedTracking(linked.guard.client, orderCode);
    if (cached) return NextResponse.json(cached, { headers: { "cache-control": "no-store" } });
    if (error instanceof GhnTrackingError) {
      const status = error.code === "UNAUTHORIZED" ? 502 : error.code === "NOT_CONFIGURED" ? 503 : 502;
      return NextResponse.json({ error: error.code, message: error.message }, { status, headers: { "cache-control": "no-store" } });
    }
    return NextResponse.json({ error: "TRACKING_UNAVAILABLE" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ incidentId: string; orderCode: string }> }) {
  const { incidentId, orderCode: rawOrderCode } = await params;
  const orderCode = decodeURIComponent(rawOrderCode).trim().toUpperCase();
  if (!ORDER_CODE_PATTERN.test(orderCode)) return NextResponse.json({ error: "INVALID_ORDER_CODE" }, { status: 400 });
  const linked = await resolveLinkedOrder(request, incidentId, orderCode);
  if (!linked.ok) return linked.response;
  const tracking = await request.json().catch(() => null) as LiveOrderTracking | null;
  if (!tracking || tracking.orderCode?.toUpperCase() !== orderCode || !Array.isArray(tracking.journey) || !tracking.checkedAt) return NextResponse.json({ error: "INVALID_TRACKING_PAYLOAD" }, { status: 400 });
  const existing = Array.isArray(linked.linkedOrder.warehouse_log) ? linked.linkedOrder.warehouse_log.filter((item: any) => !item?.[CACHE_MARKER]) : [];
  const marker = { [CACHE_MARKER]: true, saved_at: new Date().toISOString(), tracking };
  const { error } = await linked.guard.client.from("order_snapshots").update({ warehouse_log: [...existing, marker] }).eq("id", linked.linkedOrder.id);
  if (error) return NextResponse.json({ error: "TRACKING_CACHE_WRITE_FAILED" }, { status: 503 });
  return NextResponse.json({ ok: true, savedAt: marker.saved_at });
}
