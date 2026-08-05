/**
 * Approved Exception Reasons that filter out operational incidents
 */
export const APPROVED_EXCEPTION_REASONS = [
  "Khách hẹn",
  "Thiếu chứng từ",
  "Thiếu kiện",
  "CS đổi lịch",
  "Hư hỏng",
] as const;

export type ApprovedExceptionReason = (typeof APPROVED_EXCEPTION_REASONS)[number];

/**
 * Operational Incident Reasons (Rules V1)
 */
export type IncidentReason =
  | "Kho chưa lấy"
  | "Kho tồn"
  | "Kho chưa luân chuyển"
  | "Thiếu shipper";

export type IncidentReasonCode =
  | "KHO_CHU_A_LAY"
  | "KHO_TON"
  | "KHO_CHU_A_LUAN_CHUYEN"
  | "THIEU_SHIPPER";

export const REASON_CODE_MAP: Record<IncidentReason, { code: IncidentReasonCode; name: string }> = {
  "Kho chưa lấy": { code: "KHO_CHU_A_LAY", name: "Kho chưa lấy" },
  "Kho tồn": { code: "KHO_TON", name: "Kho tồn" },
  "Kho chưa luân chuyển": { code: "KHO_CHU_A_LUAN_CHUYEN", name: "Kho chưa luân chuyển" },
  "Thiếu shipper": { code: "THIEU_SHIPPER", name: "Thiếu shipper" },
};

/**
 * Helper to generate stable incident key format: warehouseId + ":" + reasonCode
 */
export function generateIncidentKey(warehouseId: string, reasonCode: string): string {
  return `${warehouseId}:${reasonCode}`;
}

/**
 * Incident Rule Thresholds Configuration
 */
export interface RuleConfig {
  readyToPickMaxHours: number; // Default 24h
  transportingMaxHours: number; // Default 24h
  deliveringMaxHours: number; // Default 12h
  storingMaxHours: number; // Default 0h (all storing orders trigger incident)
}

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  readyToPickMaxHours: 24,
  transportingMaxHours: 24,
  deliveringMaxHours: 12,
  storingMaxHours: 0,
};

export type IncidentStatus = "open" | "monitoring" | "resolved" | "ignored";

/**
 * Updated Incident Model representing consolidated operational issues
 */
export interface Incident {
  incidentId: string; // Internal UUID or unique ID
  incidentKey: string; // Stable key: warehouseId + ":" + reasonCode
  warehouseId: string;
  warehouseName: string;
  reasonCode: IncidentReasonCode;
  reasonName: string;
  status: IncidentStatus;
  priorityScore: number;
  firstDetectedAt: string;
  lastDetectedAt: string;
  resolvedAt?: string | null;
  affectedOrderCount: number;
  affectedOrders?: string[]; // Complete list of all affected order codes for backend persistence
  sampleOrderCodes: string[]; // Maximum 5 sample order codes for UI preview
  averageAgeHours: number | null;
  maximumAgeHours: number | null;
  oldestOrderCode: string | null;
}
