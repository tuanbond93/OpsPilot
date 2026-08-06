import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ incidentId: string }> }
) {
  const { incidentId } = await params;

  try {
    let dbClient;
    try {
      dbClient = createAdminClient();
    } catch {
      // Fallback
    }

    const plannerService = ServiceFactory.getPlannerService(dbClient);
    const result = await plannerService.getPlannerRunByIncidentId(incidentId);

    if (!result.ok) {
      return NextResponse.json({ error: result.error || "FetchPlannerRunFailed", message: result.message }, { status: 500 });
    }

    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "FetchPlannerRunFailed", message },
      { status: 500 }
    );
  }
}
