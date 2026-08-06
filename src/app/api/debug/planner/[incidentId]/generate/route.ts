import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ incidentId: string }> }
) {
  const { incidentId } = await params;

  try {
    const body = await request.json().catch(() => ({}));
    let dbClient;
    try {
      dbClient = createAdminClient();
    } catch {
      // Fallback
    }

    const plannerService = ServiceFactory.getPlannerService(dbClient);
    const result = await plannerService.generatePlan(incidentId, {
      provider: body.provider || undefined,
      model: body.model || undefined,
      forceRegenerate: Boolean(body.forceRegenerate),
      requestedBy: body.requestedBy ? String(body.requestedBy).trim() : undefined,
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
