// src/workflow/WorkflowResult.ts
import { WorkflowState } from './WorkflowState';

export interface WorkflowResult {
  workflowId: string;
  incidentId: string;
  state: WorkflowState;
  rootCauseResult?: any;
  plannerResult?: any;
  followupResult?: any;
  copilotResult?: any;
  errorCode?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}
