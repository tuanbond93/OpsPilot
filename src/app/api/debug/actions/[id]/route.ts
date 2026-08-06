import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ActionQueue } from "@/engine/action-queue";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const dbClient = createAdminClient();
    const queue = new ActionQueue(dbClient);
    const action = await queue.getActionById(id);

    if (!action) {
      return NextResponse.json(
        { error: "NotFound", message: `Notification action '${id}' not found.` },
        { status: 404 }
      );
    }

    const events = await queue.getActionEvents(id);

    return NextResponse.json({
      ok: true,
      action,
      events,
      deliveryOutcome: action.outcome || "SIMULATED",
      providerMessageId: action.provider_message_id || null,
      retryHistory: {
        retryCount: action.retry_count,
        maxRetry: action.max_retry,
        lastError: action.last_error || null,
      },
      lockInfo: {
        lockedAt: action.locked_at || null,
        lockedBy: action.locked_by || null,
        attemptStartedAt: action.attempt_started_at || null,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "FetchActionFailed", message },
      { status: 500 }
    );
  }
}
