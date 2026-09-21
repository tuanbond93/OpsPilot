import { NextRequest, NextResponse } from "next/server";
import { authorizeIncidentScope } from "@/security/scope-guard";
import { getRillnetCustomers } from "@/connectors/rillnet/customer-lookup";
import { classifyRawOrderDetail, ORDER_SNAPSHOT_RETENTION_DAYS } from "@/config/retention";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ incidentId: string }> }) {
  const { incidentId } = await params;
  const guard = await authorizeIncidentScope(request, incidentId);
  if (!guard.ok) return guard.response;
  const db = guard.client;
  const page = Math.max(1, Number(request.nextUrl.searchParams.get("page") || 1));
  const search = (request.nextUrl.searchParams.get("search") || "").trim().replace(/[%_]/g, "");
  const pageSize = 25;
  const { data: incident } = await db.from("incidents").select("warehouse_id,reason_code").eq("id", guard.incident.id).maybeSingle();
  if (!incident) return NextResponse.json({ error: "INCIDENT_NOT_FOUND" }, { status: 404 });
  const { data: history } = await db.from("incident_history").select("sync_run_id,oldest_order_code,recorded_at,affected_order_count,sample_order_codes").eq("incident_id", guard.incident.id).order("recorded_at", { ascending: false }).limit(1).maybeSingle();
  const historicalSummaryAvailable = Boolean(history);
  let query = db.from("order_snapshots").select("order_code,warehouse_id,warehouse_name,source_status,order_created_at,source_updated_at,age_hours,pick_warehouse_id,deliver_warehouse_id,end_pick_at,end_delivery_at,end_success_at,warehouse_log", { count: "exact" }).eq("sync_run_id", history?.sync_run_id || "00000000-0000-0000-0000-000000000000").eq("warehouse_id", incident.warehouse_id).eq("reason_code", incident.reason_code).order("age_hours", { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);
  if (search) query = query.ilike("order_code", `%${search}%`);
  const { data, count, error } = await query;
  if (error) return NextResponse.json({ error: "QUERY_FAILED", message: error.message }, { status: 500 });
  const rawStatus = classifyRawOrderDetail(history?.recorded_at, Boolean(count && count > 0));
  if (rawStatus === "EXPIRED_BY_RETENTION") {
    return NextResponse.json({ ok: true, orders: [], oldestOrderCode: history?.oldest_order_code || null, pagination: { page, pageSize, total: 0 }, raw_detail_status: rawStatus, retention_days: ORDER_SNAPSHOT_RETENTION_DAYS, historical_summary_available: historicalSummaryAvailable, historical_summary: history ? { affected_order_count: history.affected_order_count, sample_order_codes: history.sample_order_codes || [], recorded_at: history.recorded_at } : null, message: "Chi tiết đơn raw đã hết thời gian lưu trữ. Bằng chứng tổng hợp/audit của incident vẫn được giữ." });
  }

  let customers: Awaited<ReturnType<typeof getRillnetCustomers>> = {};
  try {
    customers = await getRillnetCustomers((data || []).map((order) => order.order_code));
  } catch { /* Timeline remains available if Rillnet is temporarily unavailable. */ }
  const orders = (data || []).map((order) => {
    const customer = customers[order.order_code.toUpperCase()];
    return { ...order, customer_id: customer?.customerId || null, customer_name: customer?.customerName || null, customer_code: customer?.customerCode || null };
  });
  return NextResponse.json({ ok: true, orders, oldestOrderCode: history?.oldest_order_code || null, pagination: { page, pageSize, total: count || 0 }, raw_detail_status: count && count > 0 ? "AVAILABLE" : "NOT_FOUND", retention_days: ORDER_SNAPSHOT_RETENTION_DAYS, historical_summary_available: historicalSummaryAvailable });
}
