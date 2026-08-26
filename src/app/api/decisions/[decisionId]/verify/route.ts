import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";
import { readJsonBody, resolveActor } from "@/security/api-security";
import { authorizeDecisionScope } from "@/security/scope-guard";

export async function POST(request: NextRequest, { params }: { params: Promise<{ decisionId: string }> }) {
  const { decisionId } = await params;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const scoped = await authorizeDecisionScope(request, decisionId, "RECORD_OUTCOME", { limit: 30, windowMs: 60_000 });
  if (!scoped.ok) return scoped.response;
  const body = parsed.body;
  let client; if (process.env.NODE_ENV === "production" || process.env.DECISION_PERSISTENCE === "supabase") { try { client = createAdminClient(); } catch { /* fallback */ } }
  const observedMetrics = body.observedMetrics && typeof body.observedMetrics === "object" ? body.observedMetrics as Record<string, unknown> : {};
  const affectedOrders = observedMetrics.affectedOrders;
  const result = await ServiceFactory.getDecisionService(client).verifyOutcome({
    decisionId, observedAt: typeof body.observedAt === "string" ? body.observedAt : "", source: typeof body.source === "string" ? body.source.slice(0, 200) : "",
    observedMetrics: typeof affectedOrders === "number" ? { affectedOrders } : {},
    evidenceRefs: Array.isArray(body.evidenceRefs) ? body.evidenceRefs.filter((item): item is string => typeof item === "string").slice(0, 50) : [],
    actor: resolveActor(scoped.identity, body.actor), idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
  });
  return NextResponse.json(result.ok ? result : { error: result.error, message: result.message }, { status: result.ok ? 200 : result.error === "NOT_FOUND" ? 404 : 400 });
}
