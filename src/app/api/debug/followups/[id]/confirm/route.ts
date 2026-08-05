import { NextResponse, type NextRequest } from "next/server";
import { evaluateNextState } from "@/engine/followup";
import { createAdminClient, FollowupRepository } from "@/connectors/supabase";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const action = String(body.action || "").toLowerCase().trim();
    const confirmedBy = String(body.confirmedBy || "manual_operator").trim();

    if (!["first_push", "second_push", "escalation"].includes(action)) {
      return NextResponse.json(
        {
          error: "InvalidAction",
          message: "Action must be one of 'first_push', 'second_push', or 'escalation'.",
        },
        { status: 400 }
      );
    }

    const dbClient = createAdminClient();
    const repo = new FollowupRepository(dbClient);

    const followupCase = await repo.getCaseById(id);
    if (!followupCase) {
      return NextResponse.json(
        { error: "NotFound", message: `Follow-up case '${id}' not found.` },
        { status: 404 }
      );
    }

    // Validate current pending state matches requested action
    const state = followupCase.current_state;
    if (action === "first_push" && state !== "FIRST_PUSH_PENDING") {
      return NextResponse.json(
        {
          error: "StateMismatch",
          message: `Cannot confirm 'first_push' when case state is '${state}'. Expected 'FIRST_PUSH_PENDING'.`,
        },
        { status: 400 }
      );
    }

    if (action === "second_push" && state !== "SECOND_PUSH_PENDING") {
      return NextResponse.json(
        {
          error: "StateMismatch",
          message: `Cannot confirm 'second_push' when case state is '${state}'. Expected 'SECOND_PUSH_PENDING'.`,
        },
        { status: 400 }
      );
    }

    if (action === "escalation" && state !== "ESCALATION_PENDING") {
      return NextResponse.json(
        {
          error: "StateMismatch",
          message: `Cannot confirm 'escalation' when case state is '${state}'. Expected 'ESCALATION_PENDING'.`,
        },
        { status: 400 }
      );
    }

    const transitionResult = evaluateNextState(state, {
      incidentId: followupCase.incident_id,
      incidentKey: followupCase.incident_key,
      currentCount: followupCase.latest_affected_order_count,
      baselineCount: followupCase.baseline_affected_order_count,
      previousCount: followupCase.latest_affected_order_count,
      countChangePercent: -followupCase.current_progress_percent,
      progressPercent: followupCase.current_progress_percent,
      progressAssessment: followupCase.current_assessment,
      incidentDurationHours: 0,
      isIncidentActive: true,
      timeSinceLastActionHours: 0,
      timeSinceResolvedHours: 0,
      isConfirmed: true,
      confirmedBy,
    });

    const refTimeIso = new Date().toISOString();

    const updatedCase = await repo.upsertCase({
      incident_id: followupCase.incident_id,
      incident_key: followupCase.incident_key,
      current_state: transitionResult.newState,
      first_detected_at: followupCase.first_detected_at,
      last_checked_at: refTimeIso,
      last_action_confirmed_at: refTimeIso,
      baseline_affected_order_count: followupCase.baseline_affected_order_count,
      latest_affected_order_count: followupCase.latest_affected_order_count,
      current_progress_percent: followupCase.current_progress_percent,
      current_assessment: followupCase.current_assessment,
    });

    const newEvent = await repo.insertEvent({
      followup_case_id: updatedCase.id,
      event_type: transitionResult.eventType,
      event_time: refTimeIso,
      old_state: transitionResult.oldState,
      new_state: transitionResult.newState,
      assessment: followupCase.current_assessment,
      confirmed_by: confirmedBy,
      notes: transitionResult.notes,
    });

    return NextResponse.json({
      ok: true,
      followupCase: updatedCase,
      event: newEvent,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "ConfirmationFailed", message },
      { status: 500 }
    );
  }
}
