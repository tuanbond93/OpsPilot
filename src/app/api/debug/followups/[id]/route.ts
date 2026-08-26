import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";
import { authorizeLinkedIncidentScope } from "@/security/scope-guard";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const scoped = await authorizeLinkedIncidentScope(request, "followup_cases", id, "VIEW_SYSTEM");
  if (!scoped.ok) return scoped.response;

  try {
    let dbClient;
    try {
      dbClient = createAdminClient();
    } catch {
      // Fallback
    }

    const service = ServiceFactory.getFollowupService(dbClient);
    const result = await service.getCaseById(id);

    if (!result) {
      return NextResponse.json(
        { error: "NotFound", message: `Followup case '${id}' not found.` },
        { status: 404 }
      );
    }

    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "FollowupDetailFailed", message },
      { status: 500 }
    );
  }
}
