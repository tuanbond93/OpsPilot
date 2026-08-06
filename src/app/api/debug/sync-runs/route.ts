import { NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const dbClient = createAdminClient();
    const repo = RepositoryFactory.getSyncRunRepository(dbClient);
    const runs = await repo.getLatestSyncRuns(10);

    // Sanitize output (no raw error stacks)
    const sanitizedRuns = runs.map((run) => ({
      id: run.id,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      status: run.status,
      fetchedOrderCount: run.fetched_order_count,
      normalizedOrderCount: run.normalized_order_count,
      incidentCount: run.incident_count,
      durationMs: run.duration_ms,
      errorCode: run.error_code || null,
      errorMessage: run.error_message || null,
    }));

    return NextResponse.json({
      latestSyncRuns: sanitizedRuns,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        latestSyncRuns: [],
        note: "Database connection pending or not configured",
        message,
      },
      { status: 200 }
    );
  }
}
