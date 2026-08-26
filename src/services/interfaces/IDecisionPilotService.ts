import type { DecisionServiceResult } from "./IDecisionService";

export interface CreateShadowFromIncidentInput {
  incidentId: string;
  actor: string;
  idempotencyKey?: string;
  decisionDeadline?: string | null;
}

export interface IDecisionPilotService {
  createShadowFromIncident(input: CreateShadowFromIncidentInput): Promise<DecisionServiceResult>;
}
