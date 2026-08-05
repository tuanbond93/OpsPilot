import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient, FollowupRepository } from "@/connectors/supabase";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const dbClient = createAdminClient();
    const repo = new FollowupRepository(dbClient);

    const followupCase = await repo.getCaseById(id);

    if (!followupCase) {
      return NextResponse.json(
        { error: "NotFound", message: `Followup case '${id}' not found.` },
        { status: 404 }
      );
    }

    const events = await repo.getEventsByCaseId(followupCase.id);

    return NextResponse.json({
      followupCase,
      events,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "FollowupDetailFailed", message },
      { status: 500 }
    );
  }
}
