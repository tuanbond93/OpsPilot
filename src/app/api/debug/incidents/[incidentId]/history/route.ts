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
    const { data: followupCase, error: followupError } = await dbClient
      .from("followup_cases")
      .select("id, incident_id, incident_key, current_state, next_action_at, last_checked_at, current_progress_percent, current_assessment")
      .eq("incident_id", result.incident.id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (followupError) throw followupError;

    return NextResponse.json({
      ...result,
      followup: followupCase ? {
        id: followupCase.id,
        incidentId: followupCase.incident_id,
        incidentKey: followupCase.incident_key,
        currentState: followupCase.current_state,
        nextActionAt: followupCase.next_action_at,
        lastCheckedAt: followupCase.last_checked_at,
        progressPercent: followupCase.current_progress_percent,
        progressAssessment: followupCase.current_assessment,
      } : null,
    });
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
