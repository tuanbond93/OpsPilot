import { NextRequest, NextResponse } from "next/server";
import warehouseAssignments from "@/data/warehouse-assignments.generated.json";
import { createAdminClient } from "@/connectors/supabase";
import { authorizeApiRequest, readJsonBody } from "@/security/api-security";
import { runTelegramFollowupPilotDispatch } from "@/services/telegram-followup-pilot";

type WarehouseAssignment = { warehouseId: string; warehouseName: string; zone: string; province: string };
const warehouseOptions = Array.from(new Map((warehouseAssignments.warehouses as WarehouseAssignment[]).map((warehouse) => [warehouse.warehouseName, warehouse])).values())
  .sort((left, right) => left.warehouseName.localeCompare(right.warehouseName, "vi"))
  .map(({ warehouseId, warehouseName, zone, province }) => ({ warehouseId, warehouseName, zone, province }));
const zoneOptions = Array.from(new Set(warehouseOptions.map((warehouse) => warehouse.zone).filter(Boolean)))
  .sort((left, right) => left.localeCompare(right, "vi"));
function provinceKey(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").trim().toLocaleLowerCase("vi");
}
function canonicalProvince(value: string) {
  const trimmed = value.trim();
  return provinceKey(trimmed) === "hoa binh" ? "Hòa Bình" : trimmed;
}
const provinceOptions = Array.from(new Map(warehouseOptions.filter((warehouse) => warehouse.zone === "Miền Bắc 3").map((warehouse) => {
  const province = canonicalProvince(warehouse.province);
  return [provinceKey(province), province] as const;
})).values())
  .sort((left, right) => left.localeCompare(right, "vi"));

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 30, windowMs: 60_000 });
  if (!auth.ok) return auth.response;
  const client = createAdminClient();
  const { data: groups, error: groupError } = await client.from("telegram_pilot_groups").select("*").order("created_at", { ascending: false });
  if (groupError) return NextResponse.json({ error: "TELEGRAM_PILOT_READ_FAILED", message: groupError.message }, { status: 503 });
  const [{ data: members, error: memberError }, { data: topics, error: topicError }] = await Promise.all([
    client.from("telegram_pilot_members").select("*").order("first_seen_at", { ascending: false }),
    client.from("telegram_pilot_topics").select("*").order("first_seen_at", { ascending: false }),
  ]);
  if (memberError || topicError) return NextResponse.json({ error: "TELEGRAM_PILOT_READ_FAILED", message: (memberError || topicError)?.message }, { status: 503 });
  return NextResponse.json({ ok: true, groups: groups || [], members: members || [], topics: topics || [], warehouseOptions, zoneOptions, provinceOptions });
}

export async function PATCH(request: NextRequest) {
  const parsed = await readJsonBody(request); if (!parsed.ok) return parsed.response;
  const auth = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 20, windowMs: 60_000 });
  if (!auth.ok) return auth.response;
  const topicId = typeof parsed.body.topicId === "string" ? parsed.body.topicId : "";
  if (topicId) {
    const provinceName = typeof parsed.body.provinceName === "string" ? canonicalProvince(parsed.body.provinceName) : "";
    const isEscalation = parsed.body.isEscalation === true;
    const status = ["PENDING", "ACTIVE", "SUSPENDED"].includes(String(parsed.body.status)) ? String(parsed.body.status) : "PENDING";
    if (provinceName && !provinceOptions.includes(provinceName)) return NextResponse.json({ error: "UNKNOWN_PROVINCE" }, { status: 400 });
    if (!provinceName && !isEscalation) return NextResponse.json({ error: "TOPIC_SCOPE_REQUIRED", message: "Chọn một tỉnh hoặc đánh dấu topic Escalation." }, { status: 400 });
    const client = createAdminClient();
    const { data, error } = await client.from("telegram_pilot_topics").update({ province_name: provinceName || null, is_escalation: isEscalation, status, mapped_at: new Date().toISOString(), mapped_by: auth.identity?.actor || "telegram-topic-admin" }).eq("id", topicId).select("*").maybeSingle();
    if (error) return NextResponse.json({ error: "TELEGRAM_TOPIC_MAP_FAILED", message: error.message }, { status: 503 });
    if (!data) return NextResponse.json({ error: "TELEGRAM_TOPIC_NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ ok: true, topic: data });
  }
  const memberId = typeof parsed.body.memberId === "string" ? parsed.body.memberId : "";
  const warehouseNames = Array.isArray(parsed.body.warehouseNames) ? Array.from(new Set(parsed.body.warehouseNames.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))) : [];
  const zoneNames = Array.isArray(parsed.body.zoneNames) ? Array.from(new Set(parsed.body.zoneNames.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))) : [];
  const pilotRole = parsed.body.pilotRole === "MANAGER" ? "MANAGER" : "OPERATOR";
  const status = ["PENDING", "ACTIVE", "SUSPENDED"].includes(String(parsed.body.status)) ? String(parsed.body.status) : "PENDING";
  if (!memberId || (!warehouseNames.length && !zoneNames.length)) return NextResponse.json({ error: "MEMBER_AND_SCOPE_REQUIRED", message: "Chọn ít nhất một vùng hoặc một kho phụ trách." }, { status: 400 });
  if (warehouseNames.length > 30 || warehouseNames.some((warehouseName) => !warehouseOptions.some((warehouse) => warehouse.warehouseName === warehouseName))) return NextResponse.json({ error: "UNKNOWN_WAREHOUSE" }, { status: 400 });
  if (zoneNames.length > 20 || zoneNames.some((zoneName) => !zoneOptions.includes(zoneName))) return NextResponse.json({ error: "UNKNOWN_ZONE" }, { status: 400 });
  const client = createAdminClient();
  const { data, error } = await client.from("telegram_pilot_members").update({ warehouse_name: warehouseNames[0] || null, warehouse_names: warehouseNames, zone_names: zoneNames, pilot_role: pilotRole, status, mapped_at: new Date().toISOString(), mapped_by: auth.identity?.actor || "legacy-admin" }).eq("id", memberId).select("*").maybeSingle();
  if (error) return NextResponse.json({ error: "TELEGRAM_PILOT_MAP_FAILED", message: error.message }, { status: 503 });
  if (!data) return NextResponse.json({ error: "TELEGRAM_MEMBER_NOT_FOUND" }, { status: 404 });
  // A manager has explicitly activated this member for a scoped pilot. Trust the
  // member's already-recognised group for delivery as well; otherwise the roster
  // can be valid while the dispatcher silently excludes its PENDING group.
  if (status === "ACTIVE") {
    const { error: groupActivationError } = await client
      .from("telegram_pilot_groups")
      .update({ status: "ACTIVE", updated_at: new Date().toISOString() })
      .eq("id", data.group_id)
      .eq("status", "PENDING");
    if (groupActivationError) return NextResponse.json({ error: "TELEGRAM_PILOT_GROUP_ACTIVATION_FAILED", message: groupActivationError.message }, { status: 503 });
  }
  const pilotDispatch = status === "ACTIVE" && zoneNames.includes("Miền Bắc 3")
    ? await runTelegramFollowupPilotDispatch(client, auth.identity?.actor || "telegram_pilot_mapping")
    : null;
  console.info(JSON.stringify({ category: "ADMIN_AUDIT", event: "TELEGRAM_PILOT_MEMBER_MAPPED", actor: auth.identity?.actor, memberId, warehouseNames, zoneNames, pilotRole, status, occurredAt: new Date().toISOString() }));
  return NextResponse.json({ ok: true, member: data, pilotDispatch });
}
