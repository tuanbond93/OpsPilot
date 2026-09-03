import type { DecisionComplexity, TriageRoute, TriageSeverity } from "@/engine/rules/triage";

export type TriageAuditInsert = {
  incidentId: string;
  syncRunId: string;
  route: TriageRoute;
  reasonCode: string;
  severity: TriageSeverity;
  decisionComplexity: DecisionComplexity;
  triageReason: string;
  routingVersion: string;
  evidence: Record<string, unknown>;
};

export type TriageAuditRecord = TriageAuditInsert & {
  id: string;
  createdAt: string;
};

export interface ITriageAuditRepository {
  recordBatch(items: TriageAuditInsert[]): Promise<number>;
  getLatestByIncidentIds(incidentIds: string[]): Promise<TriageAuditRecord[]>;
}
