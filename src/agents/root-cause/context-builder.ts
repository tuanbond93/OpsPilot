import type { Incident } from "../../engine/incident";
import type { IncidentHistoryRow } from "../../connectors/supabase";

export type TrendDirection = "increasing" | "decreasing" | "stable" | "insufficient_data";
export type ProgressStatus = "strong_progress" | "limited_progress" | "no_material_progress" | "worsening" | "insufficient_data";

export interface DeterministicContext extends Record<string, unknown> {
  incidentId: string;
  incidentKey: string;
  warehouseId: string;
  warehouseName: string;
  reasonCode: string;
  reasonName: string;
  status: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
  currentAffectedCount: number;
  previousAffectedCount: number;
  changeAbsolute: number;
  changePercent: number;
  trendDirection: TrendDirection;
  historyPointCount: number;
  incidentDurationHours: number;
  averageAffectedCount: number;
  peakAffectedCount: number;
  peakTime: string | null;
  progressStatus: ProgressStatus;
  averageAgeHours: number | null;
  maximumAgeHours: number | null;
  oldestOrderCode: string | null;
  sampleOrderCodes: string[];
}

/**
 * Deterministically extracts context metrics and calculates trend/progress rules
 */
export function buildRootCauseContext(
  incident: Incident,
  historyRows: IncidentHistoryRow[] = [],
  referenceTimeMs: number = Date.now()
): DeterministicContext {
  const currentAffectedCount = incident.affectedOrderCount || 0;
  const historyPointCount = historyRows.length;

  let previousAffectedCount = currentAffectedCount;
  let changeAbsolute = 0;
  let changePercent = 0;
  let trendDirection: TrendDirection = "insufficient_data";
  let progressStatus: ProgressStatus = "insufficient_data";

  if (historyPointCount >= 2) {
    // Sort history rows by recorded_at ascending
    const sortedHistory = [...historyRows].sort(
      (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
    );

    // The previous history point before the latest
    const prevRow = sortedHistory[sortedHistory.length - 2];
    previousAffectedCount = prevRow.affected_order_count;

    changeAbsolute = currentAffectedCount - previousAffectedCount;
    changePercent =
      previousAffectedCount > 0
        ? Math.round((changeAbsolute / previousAffectedCount) * 1000) / 10
        : currentAffectedCount > 0
        ? 100
        : 0;

    if (changePercent > 1) {
      trendDirection = "increasing";
    } else if (changePercent < -1) {
      trendDirection = "decreasing";
    } else {
      trendDirection = "stable";
    }

    if (changePercent <= -20) {
      progressStatus = "strong_progress";
    } else if (changePercent > -20 && changePercent <= -5) {
      progressStatus = "limited_progress";
    } else if (changePercent > -5 && changePercent < 5) {
      progressStatus = "no_material_progress";
    } else {
      progressStatus = "worsening";
    }
  }

  // Calculate incident duration in hours
  const firstTs = new Date(incident.firstDetectedAt).getTime();
  const lastTs = incident.lastDetectedAt
    ? new Date(incident.lastDetectedAt).getTime()
    : referenceTimeMs;

  const incidentDurationHours =
    !isNaN(firstTs) && !isNaN(lastTs)
      ? Math.max(0, Math.round(((lastTs - firstTs) / (1000 * 60 * 60)) * 10) / 10)
      : 0;

  // Calculate average and peak across history
  let totalHistoryCount = currentAffectedCount;
  let peakAffectedCount = currentAffectedCount;
  let peakTime: string | null = incident.lastDetectedAt || null;

  if (historyRows.length > 0) {
    totalHistoryCount = historyRows.reduce((sum, h) => sum + h.affected_order_count, 0);
    const avg = totalHistoryCount / historyRows.length;
    totalHistoryCount = Math.round(avg * 10) / 10;

    for (const h of historyRows) {
      if (h.affected_order_count > peakAffectedCount) {
        peakAffectedCount = h.affected_order_count;
        peakTime = h.recorded_at;
      }
    }
  }

  return {
    incidentId: incident.incidentId,
    incidentKey: incident.incidentKey || incident.incidentId,
    warehouseId: incident.warehouseId || "Unknown",
    warehouseName: incident.warehouseName || "Kho chưa xác định",
    reasonCode: incident.reasonCode || "Unknown",
    reasonName: incident.reasonName || "Unknown",
    status: incident.status || "open",
    firstDetectedAt: incident.firstDetectedAt || new Date(referenceTimeMs).toISOString(),
    lastDetectedAt: incident.lastDetectedAt || new Date(referenceTimeMs).toISOString(),
    currentAffectedCount,
    previousAffectedCount,
    changeAbsolute,
    changePercent,
    trendDirection,
    historyPointCount,
    incidentDurationHours,
    averageAffectedCount: totalHistoryCount,
    peakAffectedCount,
    peakTime,
    progressStatus,
    averageAgeHours: incident.averageAgeHours,
    maximumAgeHours: incident.maximumAgeHours,
    oldestOrderCode: incident.oldestOrderCode || null,
    sampleOrderCodes: incident.sampleOrderCodes || [],
  };
}
