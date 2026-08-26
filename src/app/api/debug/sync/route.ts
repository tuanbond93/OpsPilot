import { NextResponse, type NextRequest } from "next/server";
import { syncRillnet } from "@/jobs/sync-rillnet";
import { authorizeApiRequest, isAuthEnforced, isCronAuthorized } from "@/security/api-security";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function runSync(request: NextRequest) {
  if (!isCronAuthorized(request) && (isAuthEnforced() || process.env.NODE_ENV === "production")) {
    const access = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 5, windowMs: 60_000 });
    if (!access.ok) return access.response;
  }

  const result = await syncRillnet({ forceReprocessSource: true });

  if (!result.ok) {
    if (result.error?.code === "SYNC_ALREADY_RUNNING") {
      return NextResponse.json(
        {
          error: "Conflict",
          message: "A sync process is currently active and holding the distributed lock.",
          details: result,
        },
        { status: 409 }
      );
    }
    return NextResponse.json(result, { status: 500 });
  }

  return NextResponse.json(result);
}

// Vercel Cron invokes configured paths with GET. Keep POST for the existing
// authenticated manual-sync button and use the same authorization rules.
export async function GET(request: NextRequest) {
  return runSync(request);
}

export async function POST(request: NextRequest) {
  return runSync(request);
}
