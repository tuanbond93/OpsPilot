import { NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    let dbClient;
    try {
      dbClient = createAdminClient();
    } catch {
      // Fallback allowed
    }

    const qualityService = ServiceFactory.getCopilotQualityService(dbClient);
    const result = await qualityService.getQualitySummary();

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error || "GetQualitySummaryFailed", message: result.message },
        { status: 500 }
      );
    }

    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "GetQualitySummaryFailed", message },
      { status: 500 }
    );
  }
}
