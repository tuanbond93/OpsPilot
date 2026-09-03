import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";
import { readJsonBody, resolveActor } from "@/security/api-security";
import { authorizeLinkedIncidentScope } from "@/security/scope-guard";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const scoped = await authorizeLinkedIncidentScope(request, "followup_cases", id, "MANAGE_FOLLOWUP", { limit: 20, windowMs: 60_000 });
  if (!scoped.ok) return scoped.response;

  try {
    const actor = resolveActor(scoped.identity, parsed.body.confirmedBy || "manager");
    const result = await ServiceFactory.getFollowupService(createAdminClient()).resumeAfterRillnetChange(id, actor);
    if (!result.ok) {
      const status = result.error === "NotFound" ? 404 : result.error === "StateMismatch" ? 409 : 500;
      return NextResponse.json({ error: result.error, message: result.message }, { status });
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: "RILLNET_CHANGE_RESUME_FAILED", message: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
