import { NextResponse, type NextRequest } from "next/server";
import { schedulerRunner, ensureSchedulerInitialized } from "../../../../integrations/scheduler";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const cronSecret = (process.env.CRON_SECRET || "").trim();

    if (cronSecret) {
      const authHeader = request.headers.get("authorization") || "";
      const urlSecret = request.nextUrl.searchParams.get("secret") || "";

      const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.substring(7).trim() : "";
      if (bearerToken !== cronSecret && urlSecret !== cronSecret) {
        return NextResponse.json(
          { error: "Unauthorized", message: "Invalid or missing CRON_SECRET." },
          { status: 401 }
        );
      }
    }

    // Ensure jobs are registered
    await ensureSchedulerInitialized();

    const result = await schedulerRunner.runJob("dispatch-notifications");

    return NextResponse.json({
      ok: result.status === "SUCCESS",
      jobName: result.jobName,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      details: result.details,
      error: result.error,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "CronDispatchFailed", message },
      { status: 500 }
    );
  }
}
