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

    const service = ServiceFactory.getIncidentService(dbClient);
    const result = await service.getIncidentHistory(incidentId);

    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        incident: { id: incidentId, incidentKey: incidentId },
        history: [],
        note: "Database table empty or not configured",
        message,
      },
      { status: 200 }
    );
  }
}
