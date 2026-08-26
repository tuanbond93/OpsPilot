import { NextResponse, type NextRequest } from "next/server";
import { getManualSyncState, startManualSync } from "@/jobs/manual-sync-background";
import { createAdminClient } from "@/connectors/supabase";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";
import { authorizeApiRequest, isAuthEnforced, isCronAuthorized } from "@/security/api-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function authorizeSystemControl(request: NextRequest) {
  if (isCronAuthorized(request)) return null;
  if (!isAuthEnforced() && process.env.NODE_ENV === "development") return null;
  const access = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 10, windowMs: 60_000 });
  return access.ok ? null : access.response;
}

export async function GET(request: NextRequest) {
  const denial = await authorizeSystemControl(request);
  if (denial) return denial;
  let persistedRun = null;
  try {
    const repo = RepositoryFactory.getSyncRunRepository(createAdminClient());
    const run = await repo.getLatestSyncRun();
    if (run) {
      persistedRun = {
        id: run.id,
        status: run.status,
        currentPhase: run.current_phase || null,
        startedAt: run.started_at,
        completedAt: run.completed_at || null,
        durationMs: run.duration_ms || null,
        sourceUpdatedAt: run.source_updated_at || null,
      };
    }
  } catch {
    // In-memory state remains sufficient for the development-only manual control.
  }
  return NextResponse.json({ ok: true, ...getManualSyncState(), persistedRun });
}

export async function POST(request: NextRequest) {
  const denial = await authorizeSystemControl(request);
  if (denial) return denial;

  const started = startManualSync();
  if (!started.accepted) {
    return NextResponse.json(
      { ok: false, error: "SYNC_ALREADY_RUNNING", ...started.state },
      { status: 409 }
    );
  }

  return NextResponse.json(
    {
      ok: true,
      accepted: true,
      message: "Đã tiếp nhận yêu cầu đồng bộ nền.",
      ...started.state,
    },
    { status: 202 }
  );
}
