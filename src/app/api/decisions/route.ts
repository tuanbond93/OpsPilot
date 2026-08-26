import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";
import { authorizeApiRequest, readJsonBody, resolveActor } from "@/security/api-security";
import { warehouseAllowedForIdentity } from "@/security/scope-guard";
import type { Decision } from "@/domain/decision";

export const dynamic = "force-dynamic";

function service() {
  const useSupabase = process.env.NODE_ENV === "production" || process.env.DECISION_PERSISTENCE === "supabase";
  if (!useSupabase) return ServiceFactory.getDecisionService();
  try { return ServiceFactory.getDecisionService(createAdminClient()); }
  catch { return ServiceFactory.getDecisionService(); }
}

function statusFor(error?: string): number {
  if (error === "NOT_FOUND") return 404;
  if (["WRITE_CONTROLS_DISABLED", "SHADOW_MODE_READ_ONLY", "AUTONOMOUS_MODE_BLOCKED"].includes(error || "")) return 403;
  if (["VALIDATION_ERROR", "INVALID_TRANSITION"].includes(error || "")) return 400;
  return 500;
}

export async function GET(request: NextRequest) {
  const auth = await authorizeApiRequest(request, "VIEW_SYSTEM");
  if (!auth.ok) return auth.response;
  const limit = Number(request.nextUrl.searchParams.get("limit") || 100);
  const result = await service().list(Number.isFinite(limit) ? limit : 100);
  if (result.ok && auth.identity && Array.isArray(result.data)) {
    result.data = (result.data as Decision[]).filter((decision) => warehouseAllowedForIdentity(auth.identity, decision.evidence?.sourceIdentifiers?.warehouseId));
  }
  return NextResponse.json(result.ok ? result : { error: result.error, message: result.message }, { status: result.ok ? 200 : statusFor(result.error) });
}

export async function POST(request: NextRequest) {
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const auth = await authorizeApiRequest(request, "MANAGE_DECISION", { limit: 30, windowMs: 60_000 });
  if (!auth.ok) return auth.response;
  const body = { ...parsed.body, actor: resolveActor(auth.identity, parsed.body.actor) };
  const result = await service().create(body as never);
  return NextResponse.json(result.ok ? result : { error: result.error, message: result.message }, { status: result.ok ? 201 : statusFor(result.error) });
}
