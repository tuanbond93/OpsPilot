import type { SupabaseClient } from "@supabase/supabase-js";
import warehouseAssignments from "@/data/warehouse-assignments.generated.json";
import { getProvinceCode } from "@/config/pilot-provinces";

type WarehouseAssignment = { warehouseName: string; warehouseId?: string; zone: string; province: string };
type MemberRow = {
  id: string;
  group_id: string;
  telegram_user_id: number;
  display_name: string;
  username: string | null;
  role: string;
  status: string;
  private_chat_id: number | null;
  onboarding_state: string;
};
type ScopeRow = {
  id: string;
  member_id: string;
  scope_type: string;
  scope_code: string;
  permission: string;
  active: boolean;
};

// Build lookup maps from authoritative source
const warehouseData = (warehouseAssignments.warehouses as WarehouseAssignment[]);
const provinceByWarehouseName = new Map(warehouseData.map(w => [w.warehouseName, w.province]));
const provinceByWarehouseId = new Map(
  warehouseData
    .filter(w => w.warehouseId)
    .map(w => [String(w.warehouseId), w.province])
);
const regionByProvince = new Map(warehouseData.map(w => [w.province, w.zone]));
const regionByWarehouseName = new Map(warehouseData.map(w => [w.warehouseName, w.zone]));

export interface ScopeContext {
  province?: string | null;
  provinceCode?: string | null;
  warehouse?: string | null;
  warehouseId?: string | null;
  region?: string | null;
}

export interface ResolvedRecipient {
  memberId: string;
  telegramUserId: number;
  displayName: string;
  username: string | null;
  role: string;
  privateChatId: number | null;
  onboardingState: string;
  groupId: string;
  scopeMatchReason: string;
}

export interface ScopeResolutionResult {
  employees: ResolvedRecipient[];
  managers: ResolvedRecipient[];
  quarantine: boolean;
  quarantineReason?: string;
  resolvedProvince: string | null;
  resolvedRegion: string | null;
}

/**
 * Resolves the province from incident metadata using authoritative warehouse assignments.
 */
export function resolveProvince(ctx: ScopeContext): string | null {
  if (ctx.province) return ctx.province;
  if (ctx.warehouseId) {
    const p = provinceByWarehouseId.get(String(ctx.warehouseId));
    if (p) return p;
  }
  if (ctx.warehouse) {
    const p = provinceByWarehouseName.get(ctx.warehouse);
    if (p) return p;
  }
  return null;
}

/**
 * Resolves the region from incident metadata.
 */
export function resolveRegion(ctx: ScopeContext): string | null {
  if (ctx.region) return ctx.region;
  const province = resolveProvince(ctx);
  if (province) return regionByProvince.get(province) || null;
  if (ctx.warehouse) return regionByWarehouseName.get(ctx.warehouse) || null;
  return null;
}

/**
 * Normalize province name for comparison (remove diacritics, lowercase)
 */
function normalizeProvince(value: string | null | undefined): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .trim()
    .toLocaleLowerCase("vi");
}

/**
 * Check if a scope matches the given context.
 * DENY BY DEFAULT - only explicit matches authorize.
 */
function scopeMatchesContext(
  scope: ScopeRow,
  province: string | null,
  warehouse: string | null,
  region: string | null
): { matches: boolean; reason: string } {
  if (!scope.active) return { matches: false, reason: "scope_inactive" };
  
  switch (scope.scope_type) {
    case "ALL":
      return { matches: true, reason: "scope_all" };
    case "REGION":
      if (region && normalizeProvince(scope.scope_code) === normalizeProvince(region)) {
        return { matches: true, reason: `scope_region:${scope.scope_code}` };
      }
      return { matches: false, reason: "region_mismatch" };
    case "PROVINCE":
      // Scopes are stored using the stable province code (for example YBA),
      // while incident metadata carries the human-readable province name.
      // Continue accepting legacy name-based scopes during the transition.
      if (province && [province, getProvinceCode(province)].some((value) => normalizeProvince(scope.scope_code) === normalizeProvince(value))) {
        return { matches: true, reason: `scope_province:${scope.scope_code}` };
      }
      return { matches: false, reason: "province_mismatch" };
    case "WAREHOUSE":
      if (warehouse && normalizeProvince(scope.scope_code) === normalizeProvince(warehouse)) {
        return { matches: true, reason: `scope_warehouse:${scope.scope_code}` };
      }
      return { matches: false, reason: "warehouse_mismatch" };
    default:
      return { matches: false, reason: "unknown_scope_type" };
  }
}

/**
 * Resolves authorized recipients for an incident/event based on RBAC scopes.
 * DENY BY DEFAULT - if no scope matches, no recipient is authorized.
 * If scope cannot be resolved, the request is quarantined.
 */
export async function resolveAuthorizedRecipients(
  client: SupabaseClient,
  ctx: ScopeContext
): Promise<ScopeResolutionResult> {
  const province = resolveProvince(ctx);
  const region = resolveRegion(ctx);
  const warehouse = ctx.warehouse || null;
  
  // If we cannot resolve province, quarantine
  if (!province && !warehouse && !region) {
    return {
      employees: [],
      managers: [],
      quarantine: true,
      quarantineReason: "Cannot resolve province/warehouse/region from incident metadata",
      resolvedProvince: null,
      resolvedRegion: null,
    };
  }
  
  // Fetch active members with their scopes
  const { data: members, error: memberError } = await client
    .from("telegram_pilot_members")
    .select("id, group_id, telegram_user_id, display_name, username, role, status, private_chat_id, onboarding_state")
    .eq("status", "ACTIVE");
  
  if (memberError) throw memberError;
  if (!members?.length) {
    return {
      employees: [],
      managers: [],
      quarantine: true,
      quarantineReason: "No active members found",
      resolvedProvince: province,
      resolvedRegion: region,
    };
  }
  
  const memberIds = members.map(m => m.id);
  const { data: scopes, error: scopeError } = await client
    .from("telegram_user_scopes")
    .select("id, member_id, scope_type, scope_code, permission, active")
    .in("member_id", memberIds)
    .eq("active", true);
  
  if (scopeError) throw scopeError;
  
  const scopesByMember = new Map<string, ScopeRow[]>();
  for (const scope of (scopes || []) as ScopeRow[]) {
    const existing = scopesByMember.get(scope.member_id) || [];
    existing.push(scope);
    scopesByMember.set(scope.member_id, existing);
  }
  
  const employees: ResolvedRecipient[] = [];
  const managers: ResolvedRecipient[] = [];
  
  for (const member of members as MemberRow[]) {
    const memberScopes = scopesByMember.get(member.id) || [];
    
    // Check if any scope matches
    let matchReason = "";
    let authorized = false;
    
    for (const scope of memberScopes) {
      const result = scopeMatchesContext(scope, province, warehouse, region);
      if (result.matches) {
        authorized = true;
        matchReason = result.reason;
        break;
      }
    }
    
    if (!authorized) continue;
    
    const recipient: ResolvedRecipient = {
      memberId: member.id,
      telegramUserId: member.telegram_user_id,
      displayName: member.display_name,
      username: member.username,
      role: member.role,
      privateChatId: member.private_chat_id,
      onboardingState: member.onboarding_state,
      groupId: member.group_id,
      scopeMatchReason: matchReason,
    };
    
    if (member.role === "EMPLOYEE") {
      employees.push(recipient);
    } else {
      // LEAD, MANAGER, ADMIN go to managers list
      managers.push(recipient);
    }
  }
  
  return {
    employees,
    managers,
    quarantine: false,
    resolvedProvince: province,
    resolvedRegion: region,
  };
}
