import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "");
    const confirmedBy = String(body.confirmedBy || "manual_operator");

    let dbClient;
    try {
      dbClient = createAdminClient();
    } catch {
      // Fallback
    }

    const service = ServiceFactory.getFollowupService(dbClient);
    const result = await service.confirmFollowupAction(id, action, confirmedBy);

    if (!result.ok) {
      const statusMap: Record<string, number> = {
        InvalidAction: 400,
        StateMismatch: 400,
        NotFound: 404,
      };
      const status = result.error ? (statusMap[result.error] || 500) : 500;

      return NextResponse.json(
        { error: result.error || "ConfirmationFailed", message: result.message },
        { status }
      );
    }

    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "ConfirmationFailed", message },
      { status: 500 }
    );
  }
}
