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
    const result = await service.analyzeRootCause(incidentId);

    if (!result.ok) {
      const status = result.error === "NotFound" ? 404 : 500;
      return NextResponse.json(
        {
          incident: { incidentId },
          error: result.error || "RootCauseAnalysisFailed",
          message: result.message,
        },
        { status }
      );
    }

    return NextResponse.json(result.data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        incident: { incidentId },
        error: "RootCauseAnalysisFailed",
        message,
      },
      { status: 500 }
    );
  }
}
