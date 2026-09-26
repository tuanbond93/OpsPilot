import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";
import { CheckpointShadowRunner } from "@/engine/checkpoint-v2/checkpoint-shadow-runner";
import { DEFAULT_WORKER_BUDGET } from "@/domain/checkpoint-v2/types";
import { logger } from "@/observability/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Worker bounded budget <= 45s + safe tail margin

async function handleWorkerInvocation(request: NextRequest) {
  // 1. Authorization: Only CRON_SECRET or service authorization
  const cronSecret = (process.env.CRON_SECRET || "").trim();
  const authHeader = request.headers.get("authorization") || "";
  const xCronSecret = request.headers.get("x-cron-secret") || "";
  const isAuthorized =
    cronSecret !== "" && (authHeader === `Bearer ${cronSecret}` || xCronSecret === cronSecret);

  if (!isAuthorized) {
    return NextResponse.json(
      { error: "Unauthorized", message: "Invalid or missing server-side authorization" },
      { status: 401 }
    );
  }

  // 2. No-op unless production shadow flag is enabled
  if (process.env.CHECKPOINT_PIPELINE_V2_SHADOW !== "true") {
    return NextResponse.json({
      ok: true,
      status: "SKIPPED",
      reason: "SHADOW_DISABLED",
      message: "Checkpoint Pipeline V2 Shadow mode is currently disabled.",
    });
  }

  try {
    const client = createAdminClient();
    const queueRepo = RepositoryFactory.getCheckpointWorkQueueRepository(client);

    // 3. Determine target checkpoint: from query param or find active checkpoint with pending/leased SHADOW units
    let checkpointAt = request.nextUrl.searchParams.get("checkpoint_at");
    let syncRunId = request.nextUrl.searchParams.get("sync_run_id");

    if (!checkpointAt) {
      // Find oldest active checkpoint with pending or leased SHADOW work units
      const { data: activeUnits, error: queryError } = await client
        .from("checkpoint_work_units")
        .select("checkpoint_at, sync_run_id")
        .eq("execution_mode", "SHADOW")
        .in("status", ["PENDING", "LEASED"])
        .order("checkpoint_at", { ascending: true })
        .limit(1);

      if (queryError) {
        logger.error({
          category: "V2_WORKER_ERROR",
          message: `Failed to query active shadow work units: ${queryError.message}`,
        });
        return NextResponse.json({ ok: false, error: queryError.message }, { status: 500 });
      }

      if (!activeUnits || activeUnits.length === 0) {
        return NextResponse.json({
          ok: true,
          status: "IDLE",
          message: "No pending or leased SHADOW work units found.",
          unitsClaimed: 0,
          unitsCompleted: 0,
        });
      }

      checkpointAt = activeUnits[0].checkpoint_at;
      syncRunId = activeUnits[0].sync_run_id;
    }

    if (!checkpointAt) {
      return NextResponse.json({
        ok: true,
        status: "IDLE",
        message: "No target checkpoint identified.",
        unitsClaimed: 0,
        unitsCompleted: 0,
      });
    }

    const finalCheckpointAt: string = checkpointAt;
    let targetSyncRunId: string = syncRunId || "";
    if (!targetSyncRunId) {
      const { data: runData } = await client
        .from("checkpoint_work_units")
        .select("sync_run_id")
        .eq("checkpoint_at", finalCheckpointAt)
        .limit(1);
      targetSyncRunId = runData?.[0]?.sync_run_id || "unknown";
    }

    // 4. Run bounded worker batch in SHADOW execution mode
    const softBudgetParam = Number(request.nextUrl.searchParams.get("soft_budget_ms"));
    const safeTailParam = Number(request.nextUrl.searchParams.get("safe_tail_margin_ms"));
    const budgetConfig = {
      ...DEFAULT_WORKER_BUDGET,
      ...(softBudgetParam > 0 ? { softBudgetMs: softBudgetParam } : {}),
      ...(safeTailParam > 0 ? { safeTailMarginMs: safeTailParam } : {}),
    };

    const shadowRunner = new CheckpointShadowRunner(queueRepo);
    const summary = await shadowRunner.runWorkerBatch(
      finalCheckpointAt,
      targetSyncRunId,
      budgetConfig
    );

    return NextResponse.json({
      ok: true,
      status: "SUCCESS",
      checkpointAt: finalCheckpointAt,
      syncRunId: targetSyncRunId,
      summary,
    });
  } catch (err: any) {
    logger.error({
      category: "V2_WORKER_ERROR",
      message: `Worker invocation failed: ${err.message}`,
    });
    return NextResponse.json(
      { ok: false, error: err.message || "Internal worker error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  return handleWorkerInvocation(request);
}

export async function GET(request: NextRequest) {
  return handleWorkerInvocation(request);
}
