export type GhnOrderLogEntry = {
  old_data?: Record<string, unknown> | null;
  new_data?: Record<string, unknown> | null;
  created_at?: string | null;
};

export type GhnOrderLogsResponse = {
  code?: number;
  message?: string;
  data?: {
    is_order_old?: boolean;
    data?: GhnOrderLogEntry[];
  };
};

export type LiveJourneyPoint = {
  warehouseId: string;
  warehouseName: string;
  arrivedAt: string;
  departedAt?: string;
  arrivalAction?: string;
  departureAction?: string;
  current: boolean;
};

export type LiveOrderTracking = {
  orderCode: string;
  customerId: string | null;
  customerName: string | null;
  orderCreatedAt?: string | null;
  endPickAt?: string | null;
  deliveryStartedAt?: string | null;
  deliveryStartedAtInferred?: boolean;
  endDeliveryAt?: string | null;
  endSuccessAt?: string | null;
  status: string | null;
  statusLabel: string;
  phase: "AT_WAREHOUSE" | "IN_TRANSIT" | "DELIVERING" | "COMPLETED" | "UNKNOWN";
  currentWarehouseId: string | null;
  currentWarehouseName: string | null;
  nextWarehouseId: string | null;
  nextWarehouseName: string | null;
  pickWarehouseId: string | null;
  deliverWarehouseId: string | null;
  lastAction: string | null;
  lastEventAt: string | null;
  checkedAt: string;
  journey: LiveJourneyPoint[];
};
