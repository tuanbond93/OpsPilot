import { NextRequest, NextResponse } from "next/server";
import warehouseAssignments from "@/data/warehouse-assignments.generated.json";
import { createAdminClient } from "@/connectors/supabase";
import { authorizeApiRequest, readJsonBody } from "@/security/api-security";

type WarehouseAssignment = { warehouseId: string; warehouseName: string; zone: string };
const warehouseOptions = Array.from(new Map((warehouseAssignments.warehouses as WarehouseAssignment[]).map((warehouse) => [warehouse.warehouseName, warehouse])).values())
  .sort((left, right) => left.warehouseName.localeCompare(right.warehouseName, "vi"))
  .map(({ warehouseId, warehouseName, zone }) => ({ warehouseId, warehouseName, zone }));

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 30, windowMs: 60_000 });
  if (!auth.ok) return auth.response;
  const client = createAdminClient();
  const { data: groups, error: groupError } = await client.from("telegram_pilot_groups").select("*").order("created_at", { ascending: false });
  if (groupError) return NextResponse.json({ error: "TELEGRAM_PILOT_READ_FAILED", message: groupError.message }, { status: 503 });
  const { data: members, error: memberError } = await client.from("telegram_pilot_members").select("*").order("first_seen_at", { ascending: false });
  if (memberError) return NextResponse.json({ error: "TELEGRAM_PILOT_READ_FAILED", message: memberError.message }, { status: 503 });
  return NextResponse.json({ ok: true, groups: groups || [], members: members || [], warehouseOptions });
}

export async function PATCH(request: NextRequest) {
  const parsed = await readJsonBody(request); if (!parsed.ok) return parsed.response;
  const auth = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 20, windowMs: 60_000 });
  if (!auth.ok) return auth.response;
  const memberId = typeof parsed.body.memberId === "string" ? parsed.body.memberId : "";
  const warehouseName = typeof parsed.body.warehouseName === "string" ? parsed.body.warehouseName.trim() : "";
  const pilotRole = parsed.body.pilotRole === "MANAGER" ? "MANAGER" : "OPERATOR";
  const status = ["PENDING", "ACTIVE", "SUSPENDED"].includes(String(parsed.body.status)) ? String(parsed.body.status) : "PENDING";
  if (!memberId || !warehouseName) return NextResponse.json({ error: "MEMBER_AND_WAREHOUSE_REQUIRED" }, { status: 400 });
  if (!warehouseOptions.some((warehouse) => warehouse.warehouseName === warehouseName)) return NextResponse.json({ error: "UNKNOWN_WAREHOUSE" }, { status: 400 });
  const client = createAdminClient();
  const { data, error } = await client.from("telegram_pilot_members").update({ warehouse_name: warehouseName, pilot_role: pilotRole, status, mapped_at: new Date().toISOString(), mapped_by: auth.identity?.actor || "legacy-admin" }).eq("id", memberId).select("*").maybeSingle();
  if (error) return NextResponse.json({ error: "TELEGRAM_PILOT_MAP_FAILED", message: error.message }, { status: 503 });
  if (!data) return NextResponse.json({ error: "TELEGRAM_MEMBER_NOT_FOUND" }, { status: 404 });
  console.info(JSON.stringify({ category: "ADMIN_AUDIT", event: "TELEGRAM_PILOT_MEMBER_MAPPED", actor: auth.identity?.actor, memberId, warehouseName, pilotRole, status, occurredAt: new Date().toISOString() }));
  return NextResponse.json({ ok: true, member: data });
}
