import { NextResponse, type NextRequest } from "next/server";
import { schedulerRunner, ensureSchedulerInitialized } from "@/integrations/scheduler";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function runDecisionFollowups(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (process.env.NODE_ENV !== "development" && (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`)) {
    return NextResponse.json({ error: "Unauthorized", message: "Invalid or missing CRON_SECRET authorization" }, { status: 401 });
  }
  await ensureSchedulerInitialized();
  const result = await schedulerRunner.runJob("decision-followup-shadow");
  return NextResponse.json({ ok: result.status === "SUCCESS", jobName: result.jobName, startedAt: result.startedAt, finishedAt: result.finishedAt, durationMs: result.durationMs, details: result.details, error: result.error });
}

export async function GET(request: NextRequest) { return runDecisionFollowups(request); }
export async function POST(request: NextRequest) { return runDecisionFollowups(request); }
