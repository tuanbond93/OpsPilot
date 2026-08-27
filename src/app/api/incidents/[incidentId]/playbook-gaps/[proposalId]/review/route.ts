import { NextRequest, NextResponse } from "next/server";
import { readJsonBody, resolveActor } from "@/security/api-security";
import { authorizeIncidentScope } from "@/security/scope-guard";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ incidentId: string; proposalId: string }> }) {
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const { incidentId, proposalId } = await params;
  const scoped = await authorizeIncidentScope(request, incidentId, "MANAGE_FEEDBACK", { limit: 30, windowMs: 60_000 });
  if (!scoped.ok) return scoped.response;
  const actor = resolveActor(scoped.identity, parsed.body.actor);
  const decision = typeof parsed.body.decision === "string" ? parsed.body.decision.toUpperCase() : "";
  const note = typeof parsed.body.note === "string" ? parsed.body.note.trim().slice(0, 3000) : null;
  if (!actor || !["APPROVED", "REJECTED"].includes(decision)) return NextResponse.json({ error: "INVALID_REVIEW" }, { status: 400 });
  const proposal = await scoped.client.from("playbook_gap_proposals").select("id").eq("id", proposalId).eq("incident_id", scoped.incident.id).maybeSingle();
  if (proposal.error || !proposal.data) return NextResponse.json({ error: "PLAYBOOK_GAP_NOT_FOUND" }, { status: 404 });
  const created = await scoped.client.from("playbook_gap_proposal_reviews").insert({ proposal_id: proposalId, event_type: decision, actor, note });
  if (created.error) return NextResponse.json({ error: "PLAYBOOK_GAP_REVIEW_ERROR", message: created.error.message }, { status: 503 });
  return NextResponse.json({ ok: true, status: decision });
}
