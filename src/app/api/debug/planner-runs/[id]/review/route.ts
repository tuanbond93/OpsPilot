import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await request.json().catch(() => ({}));
    const decision = body.decision;
    const reviewedBy = body.reviewedBy;
    const note = body.note;

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
