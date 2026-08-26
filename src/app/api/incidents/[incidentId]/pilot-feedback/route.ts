import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { readJsonBody, resolveActor } from "@/security/api-security";
import { authorizeIncidentScope } from "@/security/scope-guard";

export const dynamic = "force-dynamic";
const causes = new Set(["STAFFING", "CAPACITY", "LINEHAUL", "PROCESS", "DATA_ERROR", "UNKNOWN", "OTHER"]);
const categories = new Set(["DATA", "SIGNAL", "AI", "UI", "OTHER"]);
const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

export async function POST(request: NextRequest, { params }: { params: Promise<{ incidentId: string }> }) {
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const permission = body.kind === "verification" ? "VERIFY_INCIDENT" : "REPORT_FEEDBACK";
  const { incidentId } = await params;
  const scoped = await authorizeIncidentScope(request, incidentId, permission, { limit: 30, windowMs: 60_000 });
  if (!scoped.ok) return scoped.response;
  const actor = resolveActor(scoped.identity, body.actor);
  if (!actor || actor.length > 200) return NextResponse.json({ error: "ACTOR_REQUIRED" }, { status: 400 });
  const db = createAdminClient();
  const { data: history } = await db.from("incident_history").select("sync_run_id").eq("incident_id", incidentId).order("recorded_at", { ascending: false }).limit(1).maybeSingle();
  let result;
  if (body.kind === "verification" && causes.has(String(body.actualCause))) {
    const evidence = text(body.evidence, 5000);
    if (!evidence) return NextResponse.json({ error: "EVIDENCE_REQUIRED" }, { status: 400 });
    result = await db.from("incident_verifications").insert({ incident_id: incidentId, sync_run_id: history?.sync_run_id || null, actual_cause: body.actualCause, evidence, notes: text(body.notes, 5000) || null, verified_by: actor }).select().single();
  } else if (body.kind === "feedback" && categories.has(String(body.category))) {
    const description = text(body.description, 5000);
    if (!description) return NextResponse.json({ error: "DESCRIPTION_REQUIRED" }, { status: 400 });
    const orderCodes = Array.isArray(body.orderCodes) ? body.orderCodes.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 120)).filter(Boolean).slice(0, 20) : [];
    result = await db.from("incident_feedback_reports").insert({ incident_id: incidentId, sync_run_id: history?.sync_run_id || null, category: body.category, description, order_codes: orderCodes, reported_by: actor }).select().single();
  } else return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
  return result.error ? NextResponse.json({ error: "PERSISTENCE_ERROR", message: result.error.message }, { status: 500 }) : NextResponse.json({ ok: true, data: result.data }, { status: 201 });
}
