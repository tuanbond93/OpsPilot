import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ incidentId: string }> }
) {
  const { incidentId } = await params;

  try {
    const dbClient = createAdminClient();
    const repo = RepositoryFactory.getPlannerRepository(dbClient);
    const aiJobRepo = RepositoryFactory.getAiJobRepository(dbClient);

    const latestRun = await repo.getLatestPlannerRunByIncidentId(incidentId);
    const aiJob = await aiJobRepo.getLatestJobByIncidentId(incidentId);

    const aiStatus = aiJob ? aiJob.status : latestRun ? "COMPLETED" : "NONE";

    if (!latestRun) {
      return NextResponse.json(
        {
          ok: true,
          aiStatus: aiJob ? aiJob.status : "PENDING",
          aiJob,
          run: null,
          message: aiJob?.status === "PENDING" || aiJob?.status === "PROCESSING"
            ? "AI analysis is running..."
            : `No planner run found for incident '${incidentId}'.`,
        },
        { status: latestRun ? 200 : 200 }
      );
    }

    const reviewEvents = await repo.getReviewEventsByRunId(latestRun.id);

    return NextResponse.json({
      ok: true,
      aiStatus,
      aiJob,
      run: latestRun,
      reviewEvents,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "FetchPlannerRunFailed", message },
      { status: 500 }
    );
  }
}
