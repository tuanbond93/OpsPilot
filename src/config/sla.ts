// SLA Configuration Matrix
export interface SLAConfig {
  orderType: "B2B" | "B2C";
  maxProcessingHours: number;
  maxDeliveryHours: number;
}

export const DEFAULT_SLA_CONFIG: SLAConfig[] = [
  { orderType: "B2B", maxProcessingHours: 4, maxDeliveryHours: 24 },
  { orderType: "B2C", maxProcessingHours: 12, maxDeliveryHours: 48 },
];
