import { NextResponse, type NextRequest } from "next/server";
import { schedulerRunner, ensureSchedulerInitialized } from "../../../../integrations/scheduler";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const isDev = process.env.NODE_ENV === "development";
  const cronSecret = process.env.CRON_SECRET;

  if (!isDev) {
    const authHeader = request.headers.get("authorization") || "";
    const expectedAuth = `Bearer ${cronSecret}`;
    if (!cronSecret || authHeader !== expectedAuth) {
      return NextResponse.json(
        { error: "Unauthorized", message: "Invalid or missing CRON_SECRET authorization" },
        { status: 401 }
      );
    }
  }

  // Ensure jobs are registered
  await ensureSchedulerInitialized();

  const result = await schedulerRunner.runJob("process-ai-jobs");

  return NextResponse.json({
    ok: result.status === "SUCCESS",
    jobName: result.jobName,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    details: result.details,
    error: result.error,
  });
}
