import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { runTelegramFollowupPilotDispatch } from "@/services/telegram-followup-pilot";
import { authorizeApiRequest, isCronAuthorized } from "@/security/api-security";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function dispatch(request: NextRequest) {
  // Cron is the normal caller. The permission fallback keeps the same route
  // operable by an authenticated manager when a scheduled Vercel invocation
  // has been delayed or skipped, without exposing a public send endpoint.
  if (!isCronAuthorized(request)) {
    const access = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 5, windowMs: 60_000 });
    if (!access.ok) return access.response;
  }
  try {
    const result = await runTelegramFollowupPilotDispatch(createAdminClient());
    console.info(JSON.stringify({
      category: "TELEGRAM_FOLLOWUP_PILOT",
      pilotZone: "Miền Bắc 3",
      scanned: result.scanned,
      sent: result.sent,
      skipped: result.skipped,
      failed: result.failed,
      details: result.details.slice(0, 20),
      occurredAt: new Date().toISOString(),
    }));
    return NextResponse.json({ ok: result.failed === 0, pilotZone: "Miền Bắc 3", startedAt: new Date().toISOString(), ...result });
  } catch (error) {
    return NextResponse.json({ error: "TELEGRAM_FOLLOWUP_PILOT_FAILED", message: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function GET(request: NextRequest) { return dispatch(request); }
export async function POST(request: NextRequest) { return dispatch(request); }
