import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { authorizeApiRequest, isCronAuthorized } from "@/security/api-security";
import { dispatchDueMb03OutcomeReminders } from "@/services/telegram-mb03-outcome-reminders";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function dispatch(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    const access = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 5, windowMs: 60_000 });
    if (!access.ok) return access.response;
  }
  try {
    const result = await dispatchDueMb03OutcomeReminders(createAdminClient());
    return NextResponse.json({ ok: result.failed === 0, ...result });
  } catch (error) {
    return NextResponse.json({ error: "MB03_OUTCOME_REMINDER_FAILED", message: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function GET(request: NextRequest) { return dispatch(request); }
export async function POST(request: NextRequest) { return dispatch(request); }
