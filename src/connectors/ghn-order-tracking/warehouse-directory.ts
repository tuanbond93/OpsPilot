import assignmentData from "@/data/warehouse-assignments.generated.json";

type WarehouseRecord = (typeof assignmentData.warehouses)[number];

const byId = new Map<string, WarehouseRecord>(assignmentData.warehouses.map((warehouse) => [warehouse.warehouseId, warehouse]));

export type WarehouseDirectoryEntry = {
  warehouseId: string;
  warehouseName: string;
  warehouseType: string;
};

export function findCanonicalWarehouse(warehouseId: string | null | undefined): WarehouseDirectoryEntry | null {
  if (!warehouseId) return null;
  const warehouse = byId.get(String(warehouseId));
  return warehouse ? { warehouseId: warehouse.warehouseId, warehouseName: warehouse.warehouseName, warehouseType: warehouse.warehouseType } : null;
}

export function canonicalWarehouseName(warehouseId: string | null | undefined, fallback?: string | null) {
  return findCanonicalWarehouse(warehouseId)?.warehouseName || fallback || (warehouseId ? `Kho ${warehouseId}` : null);
}

export function canonicalWarehouseType(warehouseId: string | null | undefined) {
  return findCanonicalWarehouse(warehouseId)?.warehouseType || null;
}
