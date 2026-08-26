import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { authorizeApiRequest, readJsonBody, resolveActor } from "@/security/api-security";
import { warehouseAllowedForIdentity } from "@/security/scope-guard";

export const dynamic = "force-dynamic";
type WorkflowEvent = { feedback_id: string; new_status: string; actor: string; note: string; occurred_at: string };

export async function GET(request: NextRequest) {
  const auth = await authorizeApiRequest(request, "VIEW_SYSTEM");
  if (!auth.ok) return auth.response;
  const db = createAdminClient();
  const category = request.nextUrl.searchParams.get("category");
  const status = request.nextUrl.searchParams.get("status");
  let query = db.from("incident_feedback_reports").select("*,incidents(warehouse_id,warehouse_name,reason_name)").order("reported_at", { ascending: false }).limit(200);
  if (category && category !== "ALL") query = query.eq("category", category);
  const { data: reports, error } = await query;
  if (error) return NextResponse.json({ error: "QUERY_FAILED", message: error.message }, { status: 500 });
  const ids = (reports || []).map((row) => row.id);
  const { data: events } = ids.length ? await db.from("incident_feedback_workflow_events").select("*").in("feedback_id", ids).order("occurred_at", { ascending: false }) : { data: [] };
  const latest = new Map<string, WorkflowEvent>();
  for (const event of (events || []) as WorkflowEvent[]) if (!latest.has(event.feedback_id)) latest.set(event.feedback_id, event);
  const items = (reports || [])
    .filter((row: any) => {
      const incident = Array.isArray(row.incidents) ? row.incidents[0] : row.incidents;
      return warehouseAllowedForIdentity(auth.identity, incident?.warehouse_id);
    })
    .map((row) => ({ ...row, currentStatus: latest.get(row.id)?.new_status || "OPEN", latestEvent: latest.get(row.id) || null }))
    .filter((row) => !status || status === "ALL" || row.currentStatus === status);
  return NextResponse.json({ ok: true, items, counts: { total: items.length, open: items.filter((item) => item.currentStatus === "OPEN").length, inProgress: items.filter((item) => item.currentStatus === "IN_PROGRESS").length, resolved: items.filter((item) => item.currentStatus === "RESOLVED").length } });
}

export async function POST(request: NextRequest) {
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const auth = await authorizeApiRequest(request, "MANAGE_FEEDBACK", { limit: 40, windowMs: 60_000 });
  if (!auth.ok) return auth.response;
  const actor = resolveActor(auth.identity, body.actor);
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 5000) : "";
  if (typeof body.feedbackId !== "string" || !actor || !note || typeof body.idempotencyKey !== "string") return NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 });
  if (!new Set(["IN_PROGRESS", "RESOLVED"]).has(String(body.targetStatus))) return NextResponse.json({ error: "INVALID_TARGET_STATUS" }, { status: 400 });
  const db = createAdminClient();
  const { data: feedback } = await db.from("incident_feedback_reports").select("incident_id,incidents(warehouse_id)").eq("id", body.feedbackId).maybeSingle();
  const incidentRelation: any = Array.isArray(feedback?.incidents) ? feedback.incidents[0] : feedback?.incidents;
  if (!feedback || !warehouseAllowedForIdentity(auth.identity, incidentRelation?.warehouse_id)) return NextResponse.json({ error: "WAREHOUSE_SCOPE_DENIED" }, { status: 403 });
  const { data: last } = await db.from("incident_feedback_workflow_events").select("new_status").eq("feedback_id", body.feedbackId).order("occurred_at", { ascending: false }).limit(1).maybeSingle();
  const previous = last?.new_status || "OPEN";
  const allowed = (previous === "OPEN" && body.targetStatus === "IN_PROGRESS") || (previous === "IN_PROGRESS" && body.targetStatus === "RESOLVED");
  if (!allowed) return NextResponse.json({ error: "INVALID_TRANSITION", message: `${previous} -> ${body.targetStatus}` }, { status: 409 });
  const { data, error } = await db.from("incident_feedback_workflow_events").insert({ feedback_id: body.feedbackId, idempotency_key: body.idempotencyKey.slice(0, 200), previous_status: previous, new_status: body.targetStatus, actor, note }).select().single();
  return error ? NextResponse.json({ error: "PERSISTENCE_ERROR", message: error.message }, { status: 500 }) : NextResponse.json({ ok: true, data }, { status: 201 });
}
