import { NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ActionQueue } from "@/engine/action-queue";
import { NotificationDispatcher } from "@/notifications";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const dbClient = createAdminClient();
    const queue = new ActionQueue(dbClient);
    const dispatcher = new NotificationDispatcher(queue);
    const health = await dispatcher.getProvidersHealth();

    return NextResponse.json({
      ok: true,
      providers: health,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "FetchProvidersFailed", message },
      { status: 500 }
    );
  }
}
