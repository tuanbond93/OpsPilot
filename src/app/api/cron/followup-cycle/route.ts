import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { syncRillnet } from "@/jobs/sync-rillnet";
import { authorizeApiRequest, isCronAuthorized } from "@/security/api-security";
import { runTelegramFollowupPilotDispatch } from "@/services/telegram-followup-pilot";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * One evidence-safe follow-up cycle.
 *
 * A Telegram reply is an explanation, not proof of resolution. This endpoint
 * always refreshes the source first; only then can the deterministic follow-up
 * state machine request a later reminder or mark an incident resolved. A
 * source snapshot that did not change never advances the reminder ladder.
 */
async function runFollowupCycle(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    const access = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 3, windowMs: 60_000 });
    if (!access.ok) return access.response;
  }

  const sync = await syncRillnet();
  if (!sync.ok) {
    const status = sync.error?.code === "SYNC_ALREADY_RUNNING" ? 409 : 500;
    return NextResponse.json({ ok: false, stage: "SYNC", sync }, { status });
  }

  // No new source evidence means the engine must not evaluate or remind again.
  if (sync.skipped || sync.skipReason === "SOURCE_UNCHANGED") {
    return NextResponse.json({
      ok: true,
      stage: "NO_FRESH_SNAPSHOT",
      sync,
      telegram: { scanned: 0, sent: 0, coveredCases: 0, skipped: 0, deferred: 0, failed: 0 },
    });
  }

  const telegram = await runTelegramFollowupPilotDispatch(createAdminClient(), "followup_cycle");
  return NextResponse.json({
    ok: telegram.failed === 0,
    stage: "COMPLETE",
    sync: {
      syncRunId: sync.syncRunId,
      completedAt: sync.completedAt,
      durationMs: sync.durationMs,
      incidentCount: sync.incidentCount,
    },
    telegram,
  });
}

export async function GET(request: NextRequest) {
  return runFollowupCycle(request);
}

export async function POST(request: NextRequest) {
  return runFollowupCycle(request);
}
