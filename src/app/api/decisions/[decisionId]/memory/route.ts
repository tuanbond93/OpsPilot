import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";
import { authorizeDecisionScope } from "@/security/scope-guard";

export async function GET(request: NextRequest, { params }: { params: Promise<{ decisionId: string }> }) {
  const { decisionId } = await params;
  const scoped = await authorizeDecisionScope(request, decisionId, "VIEW_SYSTEM");
  if (!scoped.ok) return scoped.response;
  let client; if (process.env.NODE_ENV === "production" || process.env.DECISION_PERSISTENCE === "supabase") { try { client = createAdminClient(); } catch { /* fallback */ } }
  const limit = Number(request.nextUrl.searchParams.get("limit") || 10);
  const result = await ServiceFactory.getDecisionService(client).getMemory(decisionId, Number.isFinite(limit) ? limit : 10);
  return NextResponse.json(result.ok ? result : { error: result.error, message: result.message }, { status: result.ok ? 200 : result.error === "NOT_FOUND" ? 404 : 500 });
}
