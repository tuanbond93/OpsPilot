import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";
import { authorizeApiRequest, readJsonBody, resolveActor } from "@/security/api-security";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ incidentId: string }> }
) {
  const { incidentId } = await params;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const access = await authorizeApiRequest(request, "MANAGE_SYSTEM");
  if (!access.ok) return access.response;

  try {
    const body = parsed.body;
    let dbClient;
    try {
      dbClient = createAdminClient();
    } catch {
      // Fallback
    }

    const plannerService = ServiceFactory.getPlannerService(dbClient);
    const result = await plannerService.generatePlan(incidentId, {
      provider: typeof body.provider === "string" ? body.provider : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      forceRegenerate: Boolean(body.forceRegenerate),
      requestedBy: resolveActor(access.identity, body.requestedBy) || undefined,
    });

    if (!result.ok && result.error === "MissingRequestedBy") {
      return NextResponse.json({ error: result.error, message: result.message }, { status: 400 });
    }

    if (!result.ok && result.error === "NotFound") {
      return NextResponse.json({ error: result.error, message: result.message }, { status: 404 });
    }

    if (!result.ok) {
      return NextResponse.json({ error: result.error || "PlannerGenerationFailed", message: result.message }, { status: 500 });
    }

    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "PlannerGenerationFailed", message },
      { status: 500 }
    );
  }
}
