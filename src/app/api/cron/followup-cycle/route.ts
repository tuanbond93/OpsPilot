import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { syncRillnet } from "@/jobs/sync-rillnet";
import { authorizeApiRequest, isCronAuthorized } from "@/security/api-security";
import { runTelegramFollowupPilotDispatch } from "@/services/telegram-followup-pilot";
import { dispatchRillnetChangeReviews } from "@/services/telegram-rillnet-review";
import { sendIncidentSyncStatus } from "@/services/telegram-incident-status";

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
    // A review may have been created by an earlier fresh snapshot immediately
    // before a deploy or transient Telegram failure. Deliver that human-review
    // request even when there is no newer operational evidence; never advance
    // the normal reminder ladder on an unchanged snapshot.
    const rillnetReviews = await dispatchRillnetChangeReviews(createAdminClient(), "followup_cycle_no_fresh_snapshot");
    const statusUpdates = sync.syncRunId ? await sendIncidentSyncStatus(createAdminClient(), sync.syncRunId, sync.completedAt || new Date().toISOString()) : null;
    return NextResponse.json({
      ok: rillnetReviews.failed === 0,
      stage: "NO_FRESH_SNAPSHOT",
      sync,
      telegram: { scanned: 0, sent: 0, coveredCases: 0, skipped: 0, deferred: 0, failed: 0 },
      rillnetReviews,
      statusUpdates,
    });
  }

  const telegram = await runTelegramFollowupPilotDispatch(createAdminClient(), "followup_cycle");
  const statusUpdates = await sendIncidentSyncStatus(createAdminClient(), sync.syncRunId, sync.completedAt || new Date().toISOString());
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
    statusUpdates,
  });
}

export async function GET(request: NextRequest) {
  return runFollowupCycle(request);
}

export async function POST(request: NextRequest) {
  return runFollowupCycle(request);
}
