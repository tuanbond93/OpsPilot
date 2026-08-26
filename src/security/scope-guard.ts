import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { authorizeApiRequest } from "@/security/api-security";
import { canAccessWarehouse, resolveDataScope } from "@/security/data-scope";
import type { OpsPermission } from "@/security/roles";

type Identity = NonNullable<Awaited<ReturnType<typeof authorizeApiRequest>> extends infer Result ? Result extends { identity: infer I } ? I : never : never>;

export function warehouseAllowedForIdentity(identity: Identity | null, warehouseId: unknown) {
  if (!identity) return true;
  return canAccessWarehouse(resolveDataScope(identity.role, identity.appMetadata, identity.userMetadata), warehouseId);
}

export async function authorizeLinkedIncidentScope(
  request: NextRequest,
  table: "followup_cases" | "planner_runs",
  recordId: string,
  permission: OpsPermission,
  rateLimit?: { limit: number; windowMs: number },
) {
  const auth = await authorizeApiRequest(request, permission, rateLimit);
  if (!auth.ok) return auth;
  const client = createAdminClient();
  const { data: linked, error } = await client.from(table).select("incident_id").eq("id", recordId).maybeSingle();
  if (error) return { ok: false as const, response: NextResponse.json({ error: "SCOPE_LOOKUP_FAILED" }, { status: 503 }) };
  if (!linked?.incident_id) return { ok: false as const, response: NextResponse.json({ error: "RECORD_NOT_FOUND" }, { status: 404 }) };
  const { data: incident } = await client.from("incidents").select("id,warehouse_id").eq("id", linked.incident_id).maybeSingle();
  if (!incident) return { ok: false as const, response: NextResponse.json({ error: "INCIDENT_NOT_FOUND" }, { status: 404 }) };
  if (!warehouseAllowedForIdentity(auth.identity, incident.warehouse_id)) {
    return { ok: false as const, response: NextResponse.json({ error: "WAREHOUSE_SCOPE_DENIED" }, { status: 403 }) };
  }
  return { ok: true as const, identity: auth.identity, client, incident };
}

export async function authorizeDecisionScope(
  request: NextRequest,
  decisionId: string,
  permission: OpsPermission,
  rateLimit?: { limit: number; windowMs: number },
) {
  const auth = await authorizeApiRequest(request, permission, rateLimit);
  if (!auth.ok) return auth;
  const client = createAdminClient();
  const { data: decision, error } = await client.from("decisions").select("id,incident_id").eq("id", decisionId).maybeSingle();
  if (error) return { ok: false as const, response: NextResponse.json({ error: "SCOPE_LOOKUP_FAILED" }, { status: 503 }) };
  if (!decision) return { ok: false as const, response: NextResponse.json({ error: "DECISION_NOT_FOUND" }, { status: 404 }) };
  if (!decision.incident_id) {
    if (auth.identity?.role !== "ADMIN") return { ok: false as const, response: NextResponse.json({ error: "DECISION_SCOPE_UNRESOLVED" }, { status: 403 }) };
    return { ok: true as const, identity: auth.identity, client, decision };
  }
  const { data: incident } = await client.from("incidents").select("id,warehouse_id").eq("id", decision.incident_id).maybeSingle();
  if (!incident || !warehouseAllowedForIdentity(auth.identity, incident.warehouse_id)) {
    return { ok: false as const, response: NextResponse.json({ error: "WAREHOUSE_SCOPE_DENIED" }, { status: 403 }) };
  }
  return { ok: true as const, identity: auth.identity, client, decision, incident };
}

export async function authorizeIncidentScope(
  request: NextRequest,
  incidentId: string,
  permission: OpsPermission = "VIEW_SYSTEM",
  rateLimit?: { limit: number; windowMs: number },
) {
  const auth = await authorizeApiRequest(request, permission, rateLimit);
  if (!auth.ok) return auth;
  const client = createAdminClient();
  const { data: incident, error } = await client.from("incidents").select("id,warehouse_id").or(`id.eq.${incidentId},incident_key.eq.${incidentId}`).maybeSingle();
  if (error) return { ok: false as const, response: NextResponse.json({ error: "SCOPE_LOOKUP_FAILED" }, { status: 503 }) };
  if (!incident) return { ok: false as const, response: NextResponse.json({ error: "INCIDENT_NOT_FOUND" }, { status: 404 }) };
  if (auth.identity) {
    const scope = resolveDataScope(auth.identity.role, auth.identity.appMetadata, auth.identity.userMetadata);
    if (!canAccessWarehouse(scope, incident.warehouse_id)) {
      return { ok: false as const, response: NextResponse.json({ error: scope.mode === "UNASSIGNED" ? "DATA_SCOPE_NOT_ASSIGNED" : "WAREHOUSE_SCOPE_DENIED" }, { status: 403 }) };
    }
  }
  return { ok: true as const, identity: auth.identity, client, incident };
}
