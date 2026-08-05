import { NextResponse, type NextRequest } from "next/server";
import { syncRillnet } from "@/jobs/sync-rillnet";

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

  const result = await syncRillnet();

  if (!result.ok) {
    return NextResponse.json(result, { status: 500 });
  }

  return NextResponse.json(result);
}
