import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { runDecisionFollowupShadowJob } from "@/jobs/decision-followup-shadow";
import { authorizeApiRequest, resolveActor } from "@/security/api-security";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isShadowObservation(metadata: unknown): metadata is Record<string, unknown> {
  return Boolean(metadata && typeof metadata === "object" && (metadata as Record<string, unknown>).event === "LC10_SHADOW_FOLLOWUP_OBSERVED");
}

export async function GET(request: NextRequest) {
  const access = await authorizeApiRequest(request, "VIEW_SYSTEM");
  if (!access.ok) return access.response;
  const db = createAdminClient();
  const { data, error } = await db.from("decision_audit_events")
    .select("id,decision_id,actor,occurred_at,metadata").order("occurred_at", { ascending: false }).limit(100);
  if (error) return NextResponse.json({ error: "SHADOW_RUN_HISTORY_FAILED", message: error.message }, { status: 500 });
  const items = (data || []).filter((event) => isShadowObservation(event.metadata)).slice(0, 20).map((event) => ({
    eventId: event.id, decisionId: event.decision_id, actor: event.actor, occurredAt: event.occurred_at,
    observationState: event.metadata.observationState, observedAt: event.metadata.observedAt ?? null,
    observedAffectedOrders: event.metadata.observedAffectedOrders ?? null, source: event.metadata.source ?? null,
  }));
  return NextResponse.json({ ok: true, data: items });
}

export async function POST(request: NextRequest) {
  const access = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 10, windowMs: 60_000 });
  if (!access.ok) return access.response;
  const result = await runDecisionFollowupShadowJob(Date.now(), resolveActor(access.identity, "decision-followup-admin"));
  return NextResponse.json({ ok: result.ok, data: result }, { status: result.ok ? 200 : 500 });
}
