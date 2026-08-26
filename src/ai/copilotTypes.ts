// src/ai/copilotTypes.ts

/**
 * Result object returned by the Incident Copilot.
 */
export interface IncidentCopilotResult {
  incidentId: string;
  summary: IncidentSummary;
  impact: IncidentImpact;
  escalation: EscalationRecommendation;
  evidence: EvidenceSummary;
  risk: RiskAssessment;
  confidence: number; // 0‑100
}

/** High‑level summary for executives */
export interface IncidentSummary {
  title: string;
  description: string;
  rootCause: string;
  recommendedActions: string[];
}

/** Business impact assessment */
export interface IncidentImpact {
  affectedCustomers: number;
  financialLossUsd?: number;
  downtimeMinutes?: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

/** Escalation recommendation */
export interface EscalationRecommendation {
  level: 'none' | 'manager' | 'director' | 'vp' | 'cxo';
  rationale: string;
}

/** Aggregated evidence from various stages */
export interface EvidenceSummary {
  rootCauseEvidence: string[]; // snippets or references
  plannerEvidence: string[];
  projectionEvidence: string[];
  historyEvidence: string[];
}

/** Risk assessment derived from confidence and impact */
export interface RiskAssessment {
  probability: number; // 0‑100
  impactScore: number; // 0‑100
  overallRisk: 'low' | 'medium' | 'high' | 'critical';
}
