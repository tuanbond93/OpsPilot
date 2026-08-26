import { NextResponse, type NextRequest } from "next/server";
import { ServiceFactory } from "@/services/ServiceFactory";
import { authorizeIncidentScope } from "@/security/scope-guard";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ incidentId: string }> }
) {
  const { incidentId } = await params;
  const guard = await authorizeIncidentScope(request, incidentId);
  if (!guard.ok) return guard.response;

  try {
    const dbClient = guard.client;

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
