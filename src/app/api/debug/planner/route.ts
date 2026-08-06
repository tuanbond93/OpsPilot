import { NextResponse } from "next/server";
import { createAdminClient, PlannerRepository } from "@/connectors/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const dbClient = createAdminClient();
    const repo = new PlannerRepository(dbClient);

    const runs = await repo.getAllPlannerRuns();

    return NextResponse.json({
      ok: true,
      runs,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "FetchPlannerRunsFailed", message },
      { status: 500 }
    );
  }
}
