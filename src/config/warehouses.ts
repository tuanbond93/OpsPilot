// Warehouse Configuration & Registry
export interface WarehouseConfig {
  id: string;
  name: string;
  code: string;
  region: string;
}

export const WAREHOUSES: WarehouseConfig[] = [];
