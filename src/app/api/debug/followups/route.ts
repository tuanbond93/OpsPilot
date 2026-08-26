import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";
import { authorizeApiRequest } from "@/security/api-security";
import { warehouseAllowedForIdentity } from "@/security/scope-guard";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await authorizeApiRequest(request, "VIEW_SYSTEM");
  if (!auth.ok) return auth.response;
  try {
    let dbClient;
    try {
      dbClient = createAdminClient();
    } catch {
      // Fallback
    }

    const service = ServiceFactory.getFollowupService(dbClient);
    const result = await service.getAllCases();

    if (!auth.identity || !dbClient) return NextResponse.json(result);
    const incidentIds = [...new Set(result.cases.map((item) => item.incident_id).filter(Boolean))];
    const { data: incidents } = incidentIds.length
      ? await dbClient.from("incidents").select("id,warehouse_id").in("id", incidentIds)
      : { data: [] };
    const allowedIncidentIds = new Set((incidents || []).filter((item: any) => warehouseAllowedForIdentity(auth.identity, item.warehouse_id)).map((item: any) => item.id));
    const cases = result.cases.filter((item) => allowedIncidentIds.has(item.incident_id));
    return NextResponse.json({ ...result, totalCases: cases.length, cases });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "FollowupFetchFailed", message },
      { status: 500 }
    );
  }
}
