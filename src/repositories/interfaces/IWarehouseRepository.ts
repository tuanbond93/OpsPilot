export interface WarehouseRow {
  warehouse_id: string;
  warehouse_name?: string | null;
  region?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface IWarehouseRepository {
  getAll(): Promise<WarehouseRow[]>;
  getById(id: string): Promise<WarehouseRow | null>;
}
