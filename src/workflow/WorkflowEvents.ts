// src/workflow/WorkflowEvents.ts
import { WorkflowState } from './WorkflowState';

export interface WorkflowEvent {
  workflowId: string;
  incidentId: string;
  previousState: WorkflowState | null;
  currentState: WorkflowState;
  timestamp: string;
  durationMs: number;
  errorCode?: string;
}
