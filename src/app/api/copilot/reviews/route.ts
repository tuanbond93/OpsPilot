import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";
import { authorizeApiRequest } from "@/security/api-security";
import { resolveDataScope } from "@/security/data-scope";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await authorizeApiRequest(request, "VIEW_SYSTEM");
  if (!auth.ok) return auth.response;
  try {
    const limit = Number(new URL(request.url).searchParams.get("limit") || "100");
    const client = createAdminClient();
    const service = ServiceFactory.getCopilotService(client);
    const result = await service.getReviewQueue(limit);
    if (!result.ok) return NextResponse.json(result, { status: 500 });
    const ids = [...new Set((result.items || []).map((item) => item.incidentId))];
    if (ids.length === 0) return NextResponse.json(result);
    const [{ data: incidents }, { data: histories }] = await Promise.all([
      client.from("incidents").select("id, warehouse_id, warehouse_name, reason_name").in("id", ids),
      client.from("incident_history").select("incident_id, affected_order_count, sample_order_codes, oldest_order_code, recorded_at").in("incident_id", ids).order("recorded_at", { ascending: false }),
    ]);
    const incidentById = new Map((incidents || []).map((row: any) => [row.id, row]));
    const latestHistoryByIncident = new Map<string, any>();
    for (const row of histories || []) if (!latestHistoryByIncident.has(row.incident_id)) latestHistoryByIncident.set(row.incident_id, row);
    const allowed = auth.identity ? new Set(resolveDataScope(auth.identity.role, auth.identity.appMetadata, auth.identity.userMetadata).warehouseIds) : null;
    return NextResponse.json({ ...result, items: (result.items || []).map((item) => {
      const incident = incidentById.get(item.incidentId) as any;
      const history = latestHistoryByIncident.get(item.incidentId);
      return { ...item, warehouseName: incident?.warehouse_name, reasonName: incident?.reason_name, affectedOrderCount: history?.affected_order_count, sampleOrderCodes: history?.sample_order_codes || [], oldestOrderCode: history?.oldest_order_code || null };
    }).filter((item) => !allowed || allowed.has((incidentById.get(item.incidentId) as any)?.warehouse_id)) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: "GetReviewQueueFailed", message }, { status: 500 });
  }
}
