import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient, type PlannerRunStatus } from "@/connectors/supabase";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";

export const dynamic = "force-dynamic";

const MAX_REVIEWED_BY_LENGTH = 200;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Governance check: Write controls must be explicitly allowed in production
  const writeControlsEnabled =
    process.env.ENABLE_DASHBOARD_WRITE_CONTROLS === "true" ||
    process.env.NODE_ENV !== "production";

  if (!writeControlsEnabled) {
    return NextResponse.json(
      { error: "WriteControlsDisabled", message: "Write controls are disabled in production environment." },
      { status: 403 }
    );
  }

  try {
    const body = await request.json().catch(() => ({}));

    // 1. Validate decision
    const decision = String(body.decision || "").trim().toUpperCase() as PlannerRunStatus;
    if (decision !== "APPROVED" && decision !== "REJECTED") {
      return NextResponse.json(
        {
          error: "InvalidDecision",
          message: "decision must be either 'APPROVED' or 'REJECTED'.",
        },
        { status: 400 }
      );
    }

    // 2. Validate reviewedBy: mandatory, non-empty, trimmed, max length
    const rawReviewedBy = body.reviewedBy;
    if (rawReviewedBy === undefined || rawReviewedBy === null) {
      return NextResponse.json(
        {
          error: "MissingReviewedBy",
          message: "reviewedBy is required. Provide the identity of the operator reviewing this draft.",
        },
        { status: 400 }
      );
    }

    const reviewedBy = String(rawReviewedBy).trim();
    if (reviewedBy.length === 0) {
      return NextResponse.json(
        {
          error: "EmptyReviewedBy",
          message: "reviewedBy must be a non-empty string after trimming whitespace.",
        },
        { status: 400 }
      );
    }

    if (reviewedBy.length > MAX_REVIEWED_BY_LENGTH) {
      return NextResponse.json(
        {
          error: "ReviewedByTooLong",
          message: `reviewedBy must not exceed ${MAX_REVIEWED_BY_LENGTH} characters.`,
        },
        { status: 400 }
      );
    }

    const note = body.note ? String(body.note).trim() : null;

    const dbClient = createAdminClient();
    const repo = RepositoryFactory.getPlannerRepository(dbClient);

    const run = await repo.getPlannerRunById(id);
    if (!run) {
      return NextResponse.json(
        { error: "NotFound", message: `Planner run '${id}' not found.` },
        { status: 404 }
      );
    }

    // 3. Idempotency Check: if already in target state, return success without duplicating event
    if (run.status === decision) {
      return NextResponse.json({
        ok: true,
        run,
        idempotent: true,
        message: `Planner run '${id}' is already in status '${decision}'.`,
      });
    }

    const nowIso = new Date().toISOString();

    // 4. Update status in planner_runs table
    const updatedRun = await repo.updatePlannerRunStatus(id, decision, reviewedBy, nowIso);

    // 5. Append immutable review event
    await repo.insertReviewEvent({
      planner_run_id: id,
      event_type: decision as any,
      actor: reviewedBy,
      note,
      created_at: nowIso,
    });

    // NOTE: Approved recommendation is NOT automatically executed or enqueued to Action Queue!
    return NextResponse.json({
      ok: true,
      run: updatedRun,
      idempotent: false,
      reviewedBy,
      decision,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "ReviewPlannerRunFailed", message },
      { status: 500 }
    );
  }
}
