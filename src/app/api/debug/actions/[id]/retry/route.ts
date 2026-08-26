import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ActionQueue } from "@/engine/action-queue";
import { authorizeApiRequest, readJsonBody, resolveActor } from "@/security/api-security";

export const dynamic = "force-dynamic";

const RETRIABLE_STATUSES = new Set(["FAILED", "CANCELLED"]);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const access = await authorizeApiRequest(request, "MANAGE_SYSTEM");
  if (!access.ok) return access.response;

  // 1. Governance check: Write controls must be explicitly allowed in production
  const writeControlsEnabled =
    process.env.ENABLE_DASHBOARD_WRITE_CONTROLS === "true" ||
    process.env.NODE_ENV !== "production";

  if (!writeControlsEnabled) {
    return NextResponse.json(
      { error: "WriteControlsDisabled", message: "Write controls are disabled in production environment." },
      { status: 403 }
    );
  }

  // 2. Require actor identity
  const body = parsed.body;
  const actor = resolveActor(access.identity, body.actor || body.requestedBy || body.confirmedBy);
  if (!actor) {
    return NextResponse.json(
      { error: "ActorRequired", message: "Explicit actor/requestedBy identity is required for write controls." },
      { status: 400 }
    );
  }

  try {
    let dbClient;
    try {
      dbClient = createAdminClient();
    } catch {
      // Fallback
    }
    const queue = new ActionQueue(dbClient);

    const action = await queue.getActionById(id);
    if (!action) {
      return NextResponse.json(
        { error: "NotFound", message: `Notification action '${id}' not found.` },
        { status: 404 }
      );
    }

    if (!RETRIABLE_STATUSES.has(action.status)) {
      return NextResponse.json(
        {
          error: "InvalidStateForRetry",
          message: `Cannot retry action in status '${action.status}'. Only FAILED or CANCELLED actions can be retried.`,
        },
        { status: 400 }
      );
    }

    const nowIso = new Date().toISOString();
    const oldStatus = action.status;

    const updated = await queue.updateActionStatus(id, "PENDING", {
      retry_count: 0,
      scheduled_at: nowIso,
      last_error: null,
      locked_at: null,
      locked_by: null,
      attempt_started_at: null,
    });

    await queue.appendEvent({
      action_id: id,
      event_type: "RETRY_SCHEDULED",
      old_status: oldStatus,
      new_status: "PENDING",
      attempt_number: 0,
      provider: action.provider,
      metadata: { manualRetry: true, retriedAt: nowIso, actor },
    });

    return NextResponse.json({
      ok: true,
      action: updated,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "RetryActionFailed", message },
      { status: 500 }
    );
  }
}
