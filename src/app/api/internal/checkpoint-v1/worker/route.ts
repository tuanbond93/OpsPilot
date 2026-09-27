import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { runDurableV1WorkerBatch } from "@/services/durable-v1-worker";
import { logger } from "@/observability/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(request: NextRequest) {
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }
  if (process.env.V1_DURABLE_FOLLOWUP_V0 !== "true") {
    return NextResponse.json({ ok: true, status: "DISABLED" });
  }
  try {
    const client = createAdminClient();
    const { data: active, error } = await client.from("checkpoint_work_units")
      .select("checkpoint_at,sync_run_id")
      .eq("execution_mode", "PRODUCTION")
      .like("idempotency_key", "%:V1:%")
      .in("status", ["PENDING", "LEASED"])
      .order("checkpoint_at", { ascending: true }).limit(1);
    if (error) throw error;
    if (!active?.length) return NextResponse.json({ ok: true, status: "IDLE" });
    const { checkpoint_at: checkpointAt, sync_run_id: syncRunId } = active[0];
    const summary = await runDurableV1WorkerBatch(client, checkpointAt, syncRunId);
    return NextResponse.json({ ok: true, status: "FOLLOWUP_DRAINING", checkpointAt, syncRunId, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ category: "V1_DURABLE_WORKER_ERROR", message });
    return NextResponse.json({ ok: false, error: "V1_DURABLE_WORKER_FAILED" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) { return run(request); }
