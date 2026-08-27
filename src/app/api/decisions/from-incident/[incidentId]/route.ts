import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";
import { readJsonBody, resolveActor } from "@/security/api-security";
import { authorizeIncidentScope } from "@/security/scope-guard";

function getClient() {
  if (process.env.NODE_ENV !== "production" && process.env.DECISION_PERSISTENCE !== "supabase") return undefined;
  try { return createAdminClient(); } catch { return undefined; }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ incidentId: string }> }) {
  const { incidentId } = await params;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const scoped = await authorizeIncidentScope(request, incidentId, "MANAGE_DECISION", { limit: 30, windowMs: 60_000 });
  if (!scoped.ok) return scoped.response;
  const body = parsed.body;
  const result = await ServiceFactory.getDecisionPilotService(getClient()).createShadowFromIncident({
    incidentId,
    actor: resolveActor(scoped.identity, body.actor),
    idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
    decisionDeadline: typeof body.decisionDeadline === "string" ? body.decisionDeadline : undefined,
  });
  const status = result.ok ? 201 : result.error === "NOT_FOUND" ? 404 : result.error === "WRITE_CONTROLS_DISABLED" ? 403 : result.error === "INCIDENT_ALREADY_HAS_DECISION" ? 409 : 400;
  return NextResponse.json(result.ok ? result : { error: result.error, message: result.message }, { status });
}
