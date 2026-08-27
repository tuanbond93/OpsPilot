import { NextRequest, NextResponse } from "next/server";
import { readJsonBody, resolveActor } from "@/security/api-security";
import { authorizeIncidentScope } from "@/security/scope-guard";

export const dynamic = "force-dynamic";
const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
const codes = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 120)).filter(Boolean))].slice(0, 30) : [];

export async function GET(request: NextRequest, { params }: { params: Promise<{ incidentId: string }> }) {
  const { incidentId } = await params;
  const scoped = await authorizeIncidentScope(request, incidentId, "VIEW_SYSTEM", { limit: 60, windowMs: 60_000 });
  if (!scoped.ok) return scoped.response;
  const result = await scoped.client.from("playbook_gap_proposals").select("*, playbook_gap_proposal_reviews(*)").eq("incident_id", scoped.incident.id).order("submitted_at", { ascending: false });
  if (result.error) return NextResponse.json({ error: "PLAYBOOK_GAP_LOOKUP_FAILED", message: result.error.message }, { status: 503 });
  const data = (result.data || []).map((proposal: any) => {
    const reviews = [...(proposal.playbook_gap_proposal_reviews || [])].sort((a: any, b: any) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
    return { ...proposal, status: reviews[0]?.event_type || "PENDING_REVIEW", reviews };
  });
  return NextResponse.json({ ok: true, data });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ incidentId: string }> }) {
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const { incidentId } = await params;
  const scoped = await authorizeIncidentScope(request, incidentId, "REPORT_FEEDBACK", { limit: 20, windowMs: 60_000 });
  if (!scoped.ok) return scoped.response;
  const actor = resolveActor(scoped.identity, parsed.body.actor);
  const orderCodes = codes(parsed.body.orderCodes);
  const triggerDescription = text(parsed.body.triggerDescription, 3000);
  const responsibleOwner = text(parsed.body.responsibleOwner, 300);
  const rootCause = text(parsed.body.rootCause, 3000);
  const standardAction = text(parsed.body.standardAction, 3000);
  const evidence = text(parsed.body.evidence, 5000);
  if (!actor || !orderCodes.length || !triggerDescription || !responsibleOwner || !rootCause || !standardAction || !evidence) return NextResponse.json({ error: "PLAYBOOK_GAP_FIELDS_REQUIRED" }, { status: 400 });
  const inserted = await scoped.client.from("playbook_gap_proposals").insert({ incident_id: scoped.incident.id, order_codes: orderCodes, trigger_description: triggerDescription, responsible_owner: responsibleOwner, root_cause: rootCause, standard_action: standardAction, evidence, submitted_by: actor }).select().single();
  if (inserted.error || !inserted.data) return NextResponse.json({ error: "PLAYBOOK_GAP_PERSISTENCE_ERROR", message: inserted.error?.message }, { status: 503 });
  const event = await scoped.client.from("playbook_gap_proposal_reviews").insert({ proposal_id: inserted.data.id, event_type: "SUBMITTED", actor, note: "Owner submitted an evidence-backed playbook-gap proposal." });
  if (event.error) return NextResponse.json({ error: "PLAYBOOK_GAP_AUDIT_ERROR", message: event.error.message }, { status: 503 });
  return NextResponse.json({ ok: true, data: inserted.data }, { status: 201 });
}
