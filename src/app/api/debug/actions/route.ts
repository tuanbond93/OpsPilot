import { NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ActionQueue } from "@/engine/action-queue";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const dbClient = createAdminClient();
    const queue = new ActionQueue(dbClient);
    const actions = await queue.getAllActions();

    const metrics = {
      total: actions.length,
      pending: actions.filter((a) => a.status === "PENDING").length,
      processing: actions.filter((a) => a.status === "PROCESSING").length,
      sent: actions.filter((a) => a.status === "SENT").length,
      simulated: actions.filter((a) => a.status === "SIMULATED").length,
      failed: actions.filter((a) => a.status === "FAILED").length,
      cancelled: actions.filter((a) => a.status === "CANCELLED").length,
      expired: actions.filter((a) => a.status === "EXPIRED").length,
    };

    return NextResponse.json({
      ok: true,
      metrics,
      actions,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "FetchActionsFailed", message },
      { status: 500 }
    );
  }
}
