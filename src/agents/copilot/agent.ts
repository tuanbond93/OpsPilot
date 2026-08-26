// src/agents/copilot/agent.ts

import { IncidentCopilotResult } from '../../ai/copilotTypes';

/**
 * CopilotAgent orchestrates the AI Incident Copilot step.
 * For now it combines the results of the RootCauseAgent and ActionPlannerAgent
 * into a single structured result. Future enhancements can invoke a dedicated LLM.
 */
export class CopilotAgent {
  constructor() {}

  /**
   * Run the copilot logic for a given incident.
   * @param incidentId The incident identifier.
   * @param rootCauseResult Result from RootCauseAgent (any type for now).
   * @param plannerResult Result from ActionPlannerAgent (any type for now).
   * @returns Structured IncidentCopilotResult.
   */
  async run(
    incidentId: string,
    rootCauseResult: any,
    plannerResult: any
  ): Promise<IncidentCopilotResult> {
    // Basic aggregation – in production this would invoke an LLM.
    const summary = {
      title: `Incident ${incidentId} Overview`,
      description: plannerResult?.executiveSummary || 'No executive summary available.',
      rootCause: rootCauseResult?.analysis?.summary || 'Root cause not determined.',
      recommendedActions: plannerResult?.recommendations?.map((r: any) => r.title) || [],
    };

    const impact = {
      affectedCustomers: 0,
      severity: 'medium',
    };

    const escalation = {
      level: 'none',
      rationale: 'No escalation required.',
    };

    const evidence = {
      rootCauseEvidence: rootCauseResult?.evidence?.map((e: any) => e.statement) || [],
      plannerEvidence: plannerResult?.evidenceList?.map((e: any) => e.statement) || [],
      projectionEvidence: [],
      historyEvidence: [],
    };

    const risk = {
      probability: plannerResult?.confidence ?? 0,
      impactScore: 0,
      overallRisk: 'low',
    };

    return {
      incidentId,
      summary,
      impact,
      escalation,
      evidence,
      risk,
      confidence: plannerResult?.confidence ?? 0,
    } as IncidentCopilotResult;
  }
}
