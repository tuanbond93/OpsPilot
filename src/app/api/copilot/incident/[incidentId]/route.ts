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

    const copilotService = ServiceFactory.getCopilotService(dbClient);
    const result = await copilotService.getCopilotRunByIncidentId(incidentId);

    if (!result.ok) {
      const status = result.error === "NotFound" ? 404 : 500;
      return NextResponse.json(
        { error: result.error || "GetCopilotRunFailed", message: result.message },
        { status }
      );
    }

    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "GetCopilotRunFailed", message },
      { status: 500 }
    );
  }
}
