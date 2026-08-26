import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";
import { readJsonBody, resolveActor } from "@/security/api-security";
import { authorizeIncidentScope } from "@/security/scope-guard";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ incidentId: string }> }
) {
  const { incidentId } = await params;

  try {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const scoped = await authorizeIncidentScope(request, incidentId, "REVIEW_COPILOT", { limit: 30, windowMs: 60_000 });
    if (!scoped.ok) return scoped.response;
    const status = typeof body.status === "string" && ["APPROVED", "EDITED", "REJECTED"].includes(body.status) ? body.status as "APPROVED" | "EDITED" | "REJECTED" : null;
    if (!status) return NextResponse.json({ error: "InvalidStatus" }, { status: 400 });
    const rating = typeof body.rating === "number" ? body.rating : body.rating === null ? null : undefined;
    const comment = typeof body.comment === "string" ? body.comment.trim().slice(0, 5000) : body.comment === null ? null : undefined;
    const editedResult = body.editedResult && typeof body.editedResult === "object" && !Array.isArray(body.editedResult) ? body.editedResult as Record<string, unknown> : body.editedResult === null ? null : undefined;

    // Validate supported fields only - reject direct overrides of internal context
    const reviewedBy = resolveActor(scoped.identity, request.headers.get("x-reviewer-identity") || body.reviewedBy || "operator");

    let dbClient;
    try {
      dbClient = createAdminClient();
    } catch {
      // Fallback allowed
    }

    const copilotService = ServiceFactory.getCopilotService(dbClient);
    const result = await copilotService.reviewCopilotRun(
      incidentId,
      { status, rating, comment, editedResult },
      reviewedBy
    );

    if (!result.ok) {
      const statusMap: Record<string, number> = {
        InvalidStatus: 400,
        MissingEditedResult: 400,
        InvalidRating: 400,
        NotFound: 404,
      };
      const httpStatus = result.error ? statusMap[result.error] || 500 : 500;

      return NextResponse.json(
        { error: result.error || "ReviewCopilotRunFailed", message: result.message },
        { status: httpStatus }
      );
    }

    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "ReviewCopilotRunFailed", message },
      { status: 500 }
    );
  }
}
