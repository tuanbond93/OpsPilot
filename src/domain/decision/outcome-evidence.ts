export interface OutcomeHistoryEvidence {
  id: string | number;
  syncRunId?: string | null;
  affectedOrderCount: number | null;
  recordedAt: string;
}

export interface ResolvedIncidentEvidence {
  incidentId: string;
  status: string | null;
  resolvedAt: string | null;
}

export interface PostWindowOutcomeEvidence {
  observedAffectedOrders: number;
  observedAt: string;
  source: string;
  evidenceRefs: string[];
  kind: "SNAPSHOT" | "INCIDENT_RESOLVED";
}

function isAtOrAfter(timestamp: string | null | undefined, windowEnd: string): timestamp is string {
  if (!timestamp) return false;
  const observed = Date.parse(timestamp);
  const boundary = Date.parse(windowEnd);
  return Number.isFinite(observed) && Number.isFinite(boundary) && observed >= boundary;
}

export function selectPostWindowOutcomeEvidence(
  measurementWindowEnd: string,
  history: OutcomeHistoryEvidence | null,
  incident: ResolvedIncidentEvidence | null,
): PostWindowOutcomeEvidence | null {
  if (history && isAtOrAfter(history.recordedAt, measurementWindowEnd) && Number.isFinite(history.affectedOrderCount)) {
    return {
      observedAffectedOrders: history.affectedOrderCount as number,
      observedAt: history.recordedAt,
      source: `incident_history:${history.syncRunId || history.id}`,
      evidenceRefs: [`incident_history:${history.id}`],
      kind: "SNAPSHOT",
    };
  }
  if (incident?.status === "resolved" && isAtOrAfter(incident.resolvedAt, measurementWindowEnd)) {
    return {
      observedAffectedOrders: 0,
      observedAt: incident.resolvedAt,
      source: `incident_resolution:${incident.incidentId}`,
      evidenceRefs: [`incident_resolution:${incident.incidentId}:${incident.resolvedAt}`],
      kind: "INCIDENT_RESOLVED",
    };
  }
  return null;
}
