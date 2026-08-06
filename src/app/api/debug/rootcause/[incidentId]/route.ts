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
