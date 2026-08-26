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
  let client; if (process.env.NODE_ENV === "production" || process.env.DECISION_PERSISTENCE === "supabase") { try { client = createAdminClient(); } catch { /* test fallback */ } }
  const result = await ServiceFactory.getDecisionService(client).transition({
    decisionId, targetStatus: "APPROVED", actor: resolveActor(scoped.identity, body.actor), idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
    metadata: body.metadata as Record<string, unknown> | undefined,
  });
  const status = result.ok ? 200 : result.error === "NOT_FOUND" ? 404 : result.error === "WRITE_CONTROLS_DISABLED" || result.error === "SHADOW_MODE_READ_ONLY" ? 403 : 400;
  return NextResponse.json(result.ok ? result : { error: result.error, message: result.message }, { status });
}
