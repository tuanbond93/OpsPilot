import assignmentData from "@/data/warehouse-assignments.generated.json";
import type { OpsRole } from "@/security/roles";

type WarehouseAssignment = (typeof assignmentData.warehouses)[number];
type Person = (typeof assignmentData.people)[number];
type Metadata = Record<string, unknown> | null | undefined;

const warehouses = assignmentData.warehouses as WarehouseAssignment[];
const people = assignmentData.people as Person[];
const personById = new Map(people.map((person) => [person.employeeId, person]));
const warehouseById = new Map(warehouses.map((warehouse) => [warehouse.warehouseId, warehouse]));

export type OpsDataScope = {
  mode: "ALL" | "ASSIGNED" | "UNASSIGNED";
  employeeId: string | null;
  warehouseIds: string[];
  warehouses: Array<WarehouseAssignment & { picIds: string[] }>;
};

export function employeeIdFromMetadata(appMetadata?: Metadata, userMetadata?: Metadata): string | null {
  const value = appMetadata?.opspilot_employee_id ?? userMetadata?.opspilot_employee_id;
  return typeof value === "string" || typeof value === "number" ? String(value).trim() || null : null;
}

export function resolveDataScope(role: OpsRole, appMetadata?: Metadata, userMetadata?: Metadata): OpsDataScope {
  const employeeId = employeeIdFromMetadata(appMetadata, userMetadata);
  const assigned = role === "ADMIN" ? warehouses : employeeId
    ? warehouses.filter((warehouse) => warehouse.level1.includes(employeeId) || warehouse.level2.includes(employeeId) || warehouse.level3.includes(employeeId))
    : [];
  return {
    mode: role === "ADMIN" ? "ALL" : employeeId ? "ASSIGNED" : "UNASSIGNED",
    employeeId,
    warehouseIds: assigned.map((warehouse) => warehouse.warehouseId),
    warehouses: assigned.map((warehouse) => ({ ...warehouse, picIds: [...new Set([...warehouse.level1, ...warehouse.level2, ...warehouse.level3])] })),
  };
}

export function selectWarehouseIds(scope: OpsDataScope, selection: string | null | undefined): string[] {
  const raw = (selection || "all").trim();
  if (raw === "all") return scope.warehouseIds;
  const [kind, value] = raw.includes(":") ? raw.split(":", 2) : ["warehouse", raw];
  return scope.warehouses.filter((warehouse) => {
    if (kind === "zone") return warehouse.zone === value;
    if (kind === "province") return warehouse.province === value;
    if (kind === "pic") return warehouse.picIds.includes(value);
    return warehouse.warehouseId === value;
  }).map((warehouse) => warehouse.warehouseId);
}

export function canAccessWarehouse(scope: OpsDataScope, warehouseId: unknown) {
  return typeof warehouseId === "string" && scope.warehouseIds.includes(warehouseId);
}

export function scopeResponse(scope: OpsDataScope) {
  const picIds = [...new Set(scope.warehouses.flatMap((warehouse) => warehouse.picIds))];
  return {
    mode: scope.mode,
    employeeId: scope.employeeId,
    warehouseCount: scope.warehouseIds.length,
    zones: [...new Set(scope.warehouses.map((warehouse) => warehouse.zone).filter(Boolean))].sort(),
    provinces: [...new Set(scope.warehouses.map((warehouse) => warehouse.province).filter(Boolean))].sort(),
    pics: picIds.map((employeeId) => ({ employeeId, name: personById.get(employeeId)?.name || "", title: personById.get(employeeId)?.title || "" })),
    warehouses: scope.warehouses.map(({ warehouseId, warehouseName, warehouseType, province, zone, picIds }) => ({ warehouseId, warehouseName, warehouseType, province, zone, picIds })),
    dataQuality: assignmentData.quality,
  };
}

export function assignmentForWarehouse(warehouseId: string) {
  return warehouseById.get(warehouseId) || null;
}
