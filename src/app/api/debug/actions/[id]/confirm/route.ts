import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";
import { ActionQueue } from "@/engine/action-queue";
import { ServiceFactory } from "@/services/ServiceFactory";

export const dynamic = "force-dynamic";

const MAX_CONFIRMED_BY_LENGTH = 200;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Environment protection check
  const isDev = process.env.NODE_ENV !== "production";
  const allowManual = process.env.ALLOW_MANUAL_ACTION_CONFIRM === "true";

  if (!isDev && !allowManual) {
    return NextResponse.json(
      {
        error: "ForbiddenInProduction",
        message: "Manual action confirmation is disabled in production unless ALLOW_MANUAL_ACTION_CONFIRM=true.",
      },
      { status: 403 }
    );
  }

  try {
    const body = await request.json().catch(() => ({}));

    // Validate confirmedBy: mandatory, non-empty, trimmed, max length
    const rawConfirmedBy = body.confirmedBy;
    if (rawConfirmedBy === undefined || rawConfirmedBy === null) {
      return NextResponse.json(
        {
          error: "MissingConfirmedBy",
          message: "confirmedBy is required. Provide the identity of the operator confirming this action.",
        },
        { status: 400 }
      );
    }

    const confirmedBy = String(rawConfirmedBy).trim();
    if (confirmedBy.length === 0) {
      return NextResponse.json(
        {
          error: "EmptyConfirmedBy",
          message: "confirmedBy must be a non-empty string after trimming whitespace.",
        },
        { status: 400 }
      );
    }

    if (confirmedBy.length > MAX_CONFIRMED_BY_LENGTH) {
      return NextResponse.json(
        {
          error: "ConfirmedByTooLong",
          message: `confirmedBy must not exceed ${MAX_CONFIRMED_BY_LENGTH} characters.`,
        },
        { status: 400 }
      );
    }

    const dbClient = createAdminClient();
    const queue = new ActionQueue(dbClient);
    const followupRepo = dbClient ? RepositoryFactory.getFollowupRepository(dbClient) : null;

    const action = await queue.getActionById(id);
    if (!action) {
      return NextResponse.json(
        { error: "NotFound", message: `Notification action '${id}' not found.` },
        { status: 404 }
      );
    }

    if (action.status !== "SIMULATED") {
      return NextResponse.json(
        {
          error: "InvalidStateForManualConfirmation",
          message: `Only SIMULATED actions can be manually confirmed. Action '${id}' is in status '${action.status}'.`,
        },
        { status: 400 }
      );
    }

    const refTimeIso = new Date().toISOString();

    // 1. Update action status to SENT
    const updated = await queue.updateActionStatus(id, "SENT", {
      outcome: "DELIVERED",
      processed_at: refTimeIso,
      provider_response: {
        ...(action.provider_response || {}),
        manuallyConfirmedAt: refTimeIso,
        confirmedBy,
      },
    });

    // 2. Append immutable audit event MANUAL_CONFIRMED
    await queue.appendEvent({
      action_id: id,
      event_type: "MANUAL_CONFIRMED",
      old_status: "SIMULATED",
      new_status: "SENT",
      attempt_number: action.retry_count,
      provider: action.provider,
      provider_message_id: action.provider_message_id,
      metadata: { confirmedBy, environment: process.env.NODE_ENV || "development" },
    });

    // 3. Trigger Follow-up State Confirmation
    if (updated) {
      const followupService = ServiceFactory.getFollowupService(dbClient);
      await followupService.handleFollowupStateConfirmation(updated, confirmedBy);
    }

    return NextResponse.json({
      ok: true,
      action: updated,
      confirmedBy,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "ManualConfirmationFailed", message },
      { status: 500 }
    );
  }
}
