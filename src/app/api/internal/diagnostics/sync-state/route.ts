import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";
import { authorizeApiRequest } from "@/security/api-security";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await authorizeApiRequest(request, "MANAGE_SYSTEM");
  if (!auth.ok) return auth.response;

  try {
    const adminClient = createAdminClient();
    const syncRunRepo = RepositoryFactory.getSyncRunRepository(adminClient);

    const [unfinishedRows, latestRow, lockResult] = await Promise.all([
      syncRunRepo.getUnfinishedSyncRuns(50),
      syncRunRepo.getLatestSyncRun(),
      adminClient
        .from("sync_locks")
        .select("lock_key, expires_at")
        .eq("lock_key", "global:rillnet-sync")
        .maybeSingle(),
    ]);

    if (lockResult.error) {
      throw lockResult.error;
    }

    const lockData = lockResult.data;
    const lockExpiresAtDate = lockData?.expires_at ? new Date(lockData.expires_at) : null;
    const activeSyncLock = Boolean(lockExpiresAtDate && lockExpiresAtDate.getTime() > Date.now());
    const lockExpiresAt = lockExpiresAtDate ? lockExpiresAtDate.toISOString() : null;

    const unfinishedRuns = (unfinishedRows || []).map((run) => ({
      id: run.id,
      status: run.status,
      currentPhase: run.current_phase ?? null,
      startedAt: run.started_at,
      completedAt: run.completed_at ?? null,
    }));

    const latestRun = latestRow
      ? {
          id: latestRow.id,
          status: latestRow.status,
          currentPhase: latestRow.current_phase ?? null,
          startedAt: latestRow.started_at,
          completedAt: latestRow.completed_at ?? null,
          durationMs: latestRow.duration_ms ?? null,
        }
      : null;

    return NextResponse.json({
      ok: true,
      unfinishedCount: unfinishedRuns.length,
      unfinishedRuns,
      latestRun,
      activeSyncLock,
      lockExpiresAt,
    });
  } catch (error: any) {
    return NextResponse.json(
      {
        ok: false,
        error: "SYNC_STATE_DIAGNOSTICS_FAILED",
        message: error?.message || "Internal error",
      },
      { status: 500 }
    );
  }
}
