import type { IncidentReason } from "../incident/types";

const REASON_SEVERITY_WEIGHTS: Record<IncidentReason, number> = {
  "Kho tồn": 1.5,
  "Kho chưa lấy": 1.3,
  "Thiếu shipper": 1.2,
  "Kho chưa luân chuyển": 1.0,
};

/**
 * Calculates priority score for an incident
 */
export function calculateIncidentPriorityScore(
  reason: IncidentReason,
  orderCount: number,
  maxAgeHours: number = 0
): number {
  const severityWeight = REASON_SEVERITY_WEIGHTS[reason] || 1.0;
  const countFactor = Math.min(orderCount * 2, 100);
  const ageFactor = Math.min(maxAgeHours * 0.5, 50);

  const rawScore = (countFactor + ageFactor) * severityWeight;
  return Math.round(rawScore * 10) / 10;
}
