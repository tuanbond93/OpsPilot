import type { Incident } from "../../engine/incident";
import type { IncidentHistoryRow } from "../../connectors/supabase";

export interface RootCauseContextInput extends Record<string, unknown> {
  incidentKey: string;
  warehouseId: string;
  warehouseName: string;
  reasonCode: string;
  reasonName: string;
  status: string;
  priorityScore: number;
  firstDetectedAt: string;
  lastDetectedAt: string;
  affectedOrderCount: number;
  sampleOrderCodes: string[];
  averageAgeHours: string;
  maximumAgeHours: string;
  oldestOrderCode: string;
  historyTimeline: Array<{
    recordedAt: string;
    affectedOrderCount: number;
    priorityScore: number;
    averageAgeHours: string;
  }>;
}

/**
 * Builds clean operational context input for Root Cause AI analysis
 * Enforces strict metrics accuracy to prevent LLM hallucinations.
 */
export function buildRootCauseContext(
  incident: Incident,
  historyRows: IncidentHistoryRow[] = []
): RootCauseContextInput {
  const historyTimeline = historyRows.slice(0, 5).map((h) => ({
    recordedAt: h.recorded_at,
    affectedOrderCount: h.affected_order_count,
    priorityScore: h.priority_score,
    averageAgeHours: h.average_age_hours ? `${h.average_age_hours}h` : "Unknown",
  }));

  return {
    incidentKey: incident.incidentKey || incident.incidentId,
    warehouseId: incident.warehouseId || "Unknown",
    warehouseName: incident.warehouseName || "Unknown",
    reasonCode: incident.reasonCode || "Unknown",
    reasonName: incident.reasonName || "Unknown",
    status: incident.status || "open",
    priorityScore: incident.priorityScore || 0,
    firstDetectedAt: incident.firstDetectedAt || "Unknown",
    lastDetectedAt: incident.lastDetectedAt || "Unknown",
    affectedOrderCount: incident.affectedOrderCount || 0,
    sampleOrderCodes: incident.sampleOrderCodes || [],
    averageAgeHours: incident.averageAgeHours !== null ? `${incident.averageAgeHours}h` : "Unknown",
    maximumAgeHours: incident.maximumAgeHours !== null ? `${incident.maximumAgeHours}h` : "Unknown",
    oldestOrderCode: incident.oldestOrderCode || "Unknown",
    historyTimeline,
  };
}
