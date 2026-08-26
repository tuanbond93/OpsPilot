import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";
import { readJsonBody, resolveActor } from "@/security/api-security";
import { authorizeDecisionScope } from "@/security/scope-guard";

export async function POST(request: NextRequest, { params }: { params: Promise<{ decisionId: string }> }) {
  const { decisionId } = await params;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const scoped = await authorizeDecisionScope(request, decisionId, "MANAGE_DECISION", { limit: 30, windowMs: 60_000 });
  if (!scoped.ok) return scoped.response;
  const body = parsed.body;
  let client;
  if (process.env.NODE_ENV === "production" || process.env.DECISION_PERSISTENCE === "supabase") {
    try { client = createAdminClient(); } catch { /* test fallback */ }
  }
  const result = await ServiceFactory.getDecisionService(client).recordExecution({
    decisionId,
    actor: resolveActor(scoped.identity, body.actor),
    idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
    externalTicketId: typeof body.externalTicketId === "string" && body.externalTicketId.trim() ? body.externalTicketId : undefined,
    performedAt: typeof body.performedAt === "string" ? body.performedAt : undefined,
    note: typeof body.note === "string" ? body.note : undefined,
  });
  const status = result.ok ? 200
    : result.error === "NOT_FOUND" ? 404
    : ["WRITE_CONTROLS_DISABLED", "SHADOW_MODE_READ_ONLY", "EXECUTION_BLOCKED_BY_CRITIC"].includes(result.error || "") ? 403
    : 400;
  return NextResponse.json(result.ok ? result : { error: result.error, message: result.message }, { status });
}
