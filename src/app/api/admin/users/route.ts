import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { authorizeApiRequest, readJsonBody } from "@/security/api-security";
import { normalizeOpsRole } from "@/security/roles";
import { resolveDataScope, scopeResponse } from "@/security/data-scope";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 30, windowMs: 60_000 });
  if (!auth.ok) return auth.response;
  const client = createAdminClient();
  const { data, error } = await client.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) return NextResponse.json({ error: "USER_LIST_FAILED", message: error.message }, { status: 503 });
  const users = data.users.map((user) => {
    const role = normalizeOpsRole(user.app_metadata?.opspilot_role);
    const scope = scopeResponse(resolveDataScope(role, user.app_metadata, user.user_metadata));
    return { id: user.id, email: user.email, role, employeeId: scope.employeeId, warehouseCount: scope.warehouseCount, zones: scope.zones, lastSignInAt: user.last_sign_in_at };
  });
  return NextResponse.json({ ok: true, users });
}

export async function PATCH(request: NextRequest) {
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const auth = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 20, windowMs: 60_000 });
  if (!auth.ok) return auth.response;
  const userId = typeof parsed.body.userId === "string" ? parsed.body.userId : "";
  const employeeId = typeof parsed.body.employeeId === "string" ? parsed.body.employeeId.trim() : "";
  const role = normalizeOpsRole(parsed.body.role);
  if (!userId || !employeeId) return NextResponse.json({ error: "USER_AND_EMPLOYEE_REQUIRED" }, { status: 400 });
  const scope = resolveDataScope(role, { opspilot_employee_id: employeeId }, {});
  if (role !== "ADMIN" && scope.warehouseIds.length === 0) return NextResponse.json({ error: "EMPLOYEE_HAS_NO_ASSIGNMENT" }, { status: 400 });
  const client = createAdminClient();
  const { data: existing, error: lookupError } = await client.auth.admin.getUserById(userId);
  if (lookupError || !existing.user) return NextResponse.json({ error: "USER_NOT_FOUND" }, { status: 404 });
  const previous = { role: normalizeOpsRole(existing.user.app_metadata?.opspilot_role), employeeId: existing.user.app_metadata?.opspilot_employee_id || null };
  const { data, error } = await client.auth.admin.updateUserById(userId, { app_metadata: { ...existing.user.app_metadata, opspilot_role: role, opspilot_employee_id: employeeId, opspilot_scope_updated_at: new Date().toISOString(), opspilot_scope_updated_by: auth.identity?.actor } });
  if (error) return NextResponse.json({ error: "USER_UPDATE_FAILED", message: error.message }, { status: 503 });
  console.info(JSON.stringify({ category: "ADMIN_AUDIT", event: "USER_SCOPE_UPDATED", actor: auth.identity?.actor, subjectId: userId, previous, next: { role, employeeId }, occurredAt: new Date().toISOString() }));
  return NextResponse.json({ ok: true, user: { id: data.user.id, email: data.user.email, role, employeeId, scope: scopeResponse(scope) } });
}
