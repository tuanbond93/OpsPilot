import { NextResponse, type NextRequest } from "next/server";
import { AiAnalysisWorker } from "@/jobs/ai-analysis-worker";
import { authorizeApiRequest, isCronAuthorized } from "@/security/api-security";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Explicit, administrator-authorized test runner for the persisted AI queue.
 * It is deliberately capped so an operator can validate one Level C incident
 * without bypassing the queue or exposing the production cron secret.
 */
async function run(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    const access = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 3, windowMs: 60_000 });
    if (!access.ok) return access.response;
  }
  const requested = Number(request.nextUrl.searchParams.get("maxJobs") || "1");
  const maxJobs = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), 5) : 1;
  const incidentId = request.nextUrl.searchParams.get("incidentId")?.trim();
  if (!incidentId) return NextResponse.json({ error: "INCIDENT_ID_REQUIRED", message: "incidentId is required for a targeted Level C test run." }, { status: 400 });
  const worker = new AiAnalysisWorker();
  const result = await worker.processPendingJobs(`admin-level-c-${Date.now().toString(36)}`, maxJobs, incidentId);
  return NextResponse.json({ ok: result.failedCount === 0, ...result });
}

export async function POST(request: NextRequest) { return run(request); }
export async function GET(request: NextRequest) { return run(request); }
