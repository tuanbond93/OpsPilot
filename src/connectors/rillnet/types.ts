/**
 * Custom Error Classes for Rillnet Connector
 */
export class RillnetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RillnetError";
  }
}

export class RillnetRequestError extends RillnetError {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "RillnetRequestError";
  }
}

export class RillnetInvalidUrlError extends RillnetError {
  constructor(message: string) {
    super(message);
    this.name = "RillnetInvalidUrlError";
  }
}

export class RillnetDownloadError extends RillnetError {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "RillnetDownloadError";
  }
}

export class RillnetDecompressError extends RillnetError {
  constructor(message: string) {
    super(message);
    this.name = "RillnetDecompressError";
  }
}

export class RillnetParseError extends RillnetError {
  constructor(message: string) {
    super(message);
    this.name = "RillnetParseError";
  }
}

/**
 * Raw API Response Types
 */
export interface RillnetSnapResponse {
  url?: string;
  liveUrl?: string;
  updated?: string;
  liveUpdated?: string;
}

export interface RawRillnetOrder {
  order_code?: string;
  code?: string;
  status?: string;
  current_warehouse_id?: string | number;
  current_warehouse_name?: string;
  deliver_warehouse_name?: string;
  client_id?: string | number;
  client_order_code?: string;
  created_date?: string;
  order_date?: string;
  [key: string]: unknown;
}

export interface RillnetWarehouseMetadata {
  p?: string;
  [key: string]: unknown;
}

export type RillnetWarehouseMetaMap = Record<string, RillnetWarehouseMetadata>;

/**
 * Normalized OpsPilot Order Model
 */
export interface NormalizedRillnetOrder {
  id: string;
  orderCode: string;
  status: string;
  taskCategory: string;
  warehouseId: string;
  warehouseName: string;
  customerId: string;
  customerName: string;
  customerCode: string;
  createdAt: string | null;
  fetchedAt: string;
}

export interface RillnetFetchResult {
  fetchedAt: string;
  totalOrders: number;
  orders: NormalizedRillnetOrder[];
}

export interface RillnetDebugSummary {
  fetchedAt: string;
  totalOrders: number;
  statusCounts: Record<string, number>;
  first5Orders: NormalizedRillnetOrder[];
}
