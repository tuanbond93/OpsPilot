import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { analyzeB2bConsolidation, type ConsolidationAnalysisInput } from "@/domain/b2b-consolidation";
import { authorizeApiRequest, readJsonBody, resolveActor } from "@/security/api-security";

export const dynamic = "force-dynamic";

function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function numeric(value: unknown) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function iso(value: unknown) { return typeof value === "string" && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : ""; }

function parseInput(body: Record<string, unknown>): ConsolidationAnalysisInput | null {
  const rawTrip = body.trip;
  const rawOrders = body.orders;
  if (!rawTrip || typeof rawTrip !== "object" || Array.isArray(rawTrip) || !Array.isArray(rawOrders) || rawOrders.length === 0 || rawOrders.length > 100) return null;
  const trip = rawTrip as Record<string, unknown>;
  const parsedTrip = { tripId: text(trip.tripId), originWarehouse: text(trip.originWarehouse), destinationWarehouse: text(trip.destinationWarehouse), departureAt: iso(trip.departureAt), capacityKg: numeric(trip.capacityKg), bookedKg: numeric(trip.bookedKg), capacityM3: numeric(trip.capacityM3), bookedM3: numeric(trip.bookedM3) };
  if (!parsedTrip.tripId || !parsedTrip.originWarehouse || !parsedTrip.destinationWarehouse || !parsedTrip.departureAt) return null;
  const orders = rawOrders.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const order = raw as Record<string, unknown>;
    const parsed = { orderCode: text(order.orderCode), readyAt: iso(order.readyAt), latestSafeDepartureAt: iso(order.latestSafeDepartureAt), weightKg: numeric(order.weightKg), volumeM3: numeric(order.volumeM3) };
    return parsed.orderCode && parsed.readyAt && parsed.latestSafeDepartureAt ? parsed : null;
  });
  if (orders.some((order) => !order)) return null;
  return { trip: parsedTrip, orders: orders.filter((order): order is NonNullable<typeof order> => Boolean(order)) };
}

export async function GET(request: NextRequest) {
  const authorized = await authorizeApiRequest(request, "VIEW_SYSTEM");
  if (!authorized.ok) return authorized.response;
  try {
    const db = createAdminClient();
    const { data, error } = await db.from("b2b_consolidation_shadow_runs").select("id, created_by, verdict, trip, orders, result, created_at").order("created_at", { ascending: false }).limit(20);
    if (error) throw error;
    return NextResponse.json({ ok: true, data: data || [] });
  } catch (error) {
    return NextResponse.json({ error: "CONSOLIDATION_STORE_UNAVAILABLE", message: error instanceof Error ? error.message : "Không thể tải lịch sử phân tích ghép chuyến." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const authorized = await authorizeApiRequest(request, "MANAGE_DECISION", { limit: 20, windowMs: 60_000 });
  if (!authorized.ok) return authorized.response;
  const input = parseInput(parsed.body);
  const actor = resolveActor(authorized.identity, parsed.body.actor);
  const idempotencyKey = text(parsed.body.idempotencyKey);
  if (!input || !actor || !idempotencyKey) return NextResponse.json({ error: "VALIDATION_ERROR", message: "Trip, orders, actor và idempotencyKey hợp lệ là bắt buộc." }, { status: 400 });
  const result = analyzeB2bConsolidation(input);
  try {
    const db = createAdminClient();
    const existing = await db.from("b2b_consolidation_shadow_runs").select("id, created_by, verdict, trip, orders, result, created_at").eq("idempotency_key", idempotencyKey).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) return NextResponse.json({ ok: true, data: existing.data, idempotent: true });
    const inserted = await db.from("b2b_consolidation_shadow_runs").insert({ idempotency_key: idempotencyKey, created_by: actor, mode: "SHADOW", verdict: result.verdict, trip: input.trip, orders: input.orders, result }).select("id, created_by, verdict, trip, orders, result, created_at").single();
    if (inserted.error || !inserted.data) throw inserted.error || new Error("INSERT_FAILED");
    const audit = await db.from("b2b_consolidation_shadow_audits").insert({ run_id: inserted.data.id, event_type: "CREATED", actor, details: { mode: "SHADOW", financialImpact: "NOT_EVALUATED" } });
    if (audit.error) throw audit.error;
    return NextResponse.json({ ok: true, data: inserted.data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: "CONSOLIDATION_STORE_UNAVAILABLE", message: error instanceof Error ? error.message : "Không thể lưu phân tích ghép chuyến." }, { status: 503 });
  }
}
