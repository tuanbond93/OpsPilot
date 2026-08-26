import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";
import { readJsonBody, resolveActor } from "@/security/api-security";
import { authorizeLinkedIncidentScope } from "@/security/scope-guard";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const scoped = await authorizeLinkedIncidentScope(request, "planner_runs", id, "REVIEW_COPILOT", { limit: 30, windowMs: 60_000 });
    if (!scoped.ok) return scoped.response;
    const body = parsed.body;
    const decision = typeof body.decision === "string" ? body.decision : "";
    const reviewedBy = resolveActor(scoped.identity, body.reviewedBy);
    const note = typeof body.note === "string" ? body.note.slice(0, 5000) : undefined;

    let dbClient;
    try {
      dbClient = createAdminClient();
    } catch {
      // Fallback
    }

    const plannerService = ServiceFactory.getPlannerService(dbClient);
    const result = await plannerService.reviewPlannerRun(id, decision, reviewedBy, note);

    if (!result.ok) {
      const statusMap: Record<string, number> = {
        WriteControlsDisabled: 403,
        InvalidDecision: 400,
        MissingReviewedBy: 400,
        EmptyReviewedBy: 400,
        ReviewedByTooLong: 400,
        NotFound: 404,
      };
      const status = result.error ? (statusMap[result.error] || 500) : 500;

      return NextResponse.json(
        { error: result.error || "ReviewPlannerRunFailed", message: result.message },
        { status }
      );
    }

    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "ReviewPlannerRunFailed", message },
      { status: 500 }
    );
  }
}
