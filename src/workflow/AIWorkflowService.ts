// src/workflow/AIWorkflowService.ts

import { randomUUID } from 'node:crypto';
import { WorkflowState } from './WorkflowState';
import { CopilotAgent } from '@/agents/copilot';
import { RetryPolicy } from './RetryPolicy';
import { ServiceFactory } from '@/services/ServiceFactory';
import { RepositoryFactory } from '@/repositories/RepositoryFactory';
import { logger } from '@/observability/logger';
import type { IIncidentService } from '@/services/interfaces/IIncidentService';
import type { IPlannerService } from '@/services/interfaces/IPlannerService';
import type { IFollowupService } from '@/services/interfaces/IFollowupService';
import type { ICopilotRepository } from '@/repositories/interfaces/ICopilotRepository';
import type { WorkflowResult } from './WorkflowResult';
import type { WorkflowEvent } from './WorkflowEvents';

export class AIWorkflowService {
  private incidentService: IIncidentService;
  private plannerService: IPlannerService;
  private followupService: IFollowupService;
  private copilotRepo: ICopilotRepository;
  private copilotAgent: CopilotAgent;

  private cancelled = false;

  constructor(
    private workflowId: string = randomUUID(),
    client?: any
  ) {
    this.incidentService = ServiceFactory.getIncidentService(client);
    this.plannerService = ServiceFactory.getPlannerService(client);
    this.followupService = ServiceFactory.getFollowupService(client);
    this.copilotRepo = RepositoryFactory.getCopilotRepository(client);
    this.copilotAgent = new CopilotAgent();
  }

  /**
   * Executes the initial workflow up to COPILOT_AWAITING_REVIEW.
   * Persists copilot run and initial PENDING review to DB, then returns.
   */
  async execute(incidentId: string): Promise<WorkflowResult> {
    const start = Date.now();
    this.incidentId = incidentId;
    const result: WorkflowResult = {
      workflowId: this.workflowId,
      incidentId,
      state: WorkflowState.NEW,
      startedAt: new Date(start).toISOString(),
    };
    await this.emitEvent(undefined, WorkflowState.NEW);

    try {
      // NEW -> ROOTCAUSE_RUNNING -> ROOTCAUSE_COMPLETED
      await this.transitionState(WorkflowState.ROOTCAUSE_RUNNING);
      const rootCause = await RetryPolicy.retry(
        () => this.incidentService.analyzeRootCause(incidentId),
        3,
        200
      );
      result.rootCauseResult = rootCause.data;
      await this.transitionState(WorkflowState.ROOTCAUSE_COMPLETED);

      // ROOTCAUSE_COMPLETED -> PLANNER_RUNNING -> PLANNER_COMPLETED
      await this.transitionState(WorkflowState.PLANNER_RUNNING);
      const planner = await RetryPolicy.retry(
        () =>
          this.plannerService.generatePlan(incidentId, {
            provider: undefined,
            model: undefined,
            forceRegenerate: false,
          }),
        3,
        200
      );
      result.plannerResult = planner.result;
      await this.transitionState(WorkflowState.PLANNER_COMPLETED);

      // PLANNER_COMPLETED -> COPILOT_RUNNING -> COPILOT_COMPLETED
      await this.transitionState(WorkflowState.COPILOT_RUNNING);
      const copilotResult = await this.copilotAgent.run(
        incidentId,
        result.rootCauseResult,
        result.plannerResult
      );
      result.copilotResult = copilotResult;
      await this.transitionState(WorkflowState.COPILOT_COMPLETED);

      // Persist copilot_runs record
      const runRow = await this.copilotRepo.createCopilotRun({
        incident_id: incidentId,
        workflow_id: this.workflowId,
        prompt_id: 'copilot',
        prompt_version: 'v1',
        provider: 'openai',
        model: 'default',
        copilot_result: copilotResult as any,
      });

      // Insert initial PENDING active review
      await this.copilotRepo.createReview({
        run_id: runRow.id,
        incident_id: incidentId,
        workflow_id: this.workflowId,
        status: 'PENDING',
        is_active: true,
        prompt_id: 'copilot',
        prompt_version: 'v1',
        provider: 'openai',
        model: 'default',
      });

      // COPILOT_COMPLETED -> COPILOT_AWAITING_REVIEW
      await this.transitionState(WorkflowState.COPILOT_AWAITING_REVIEW);
      result.state = WorkflowState.COPILOT_AWAITING_REVIEW;
      result.completedAt = new Date().toISOString();
      result.durationMs = Date.now() - start;

      logger.info({
        component: 'AIWorkflowService',
        operation: 'pauseForHumanReview',
        workflowId: this.workflowId,
        incidentId,
        runId: runRow.id,
        state: WorkflowState.COPILOT_AWAITING_REVIEW,
      });
    } catch (err: unknown) {
      if (this.cancelled) {
        await this.transitionState(WorkflowState.CANCELLED);
        result.state = WorkflowState.CANCELLED;
        result.error = 'Cancelled';
      } else {
        await this.transitionState(WorkflowState.FAILED, err);
        result.state = WorkflowState.FAILED;
        result.error = err instanceof Error ? err.message : String(err);
      }
      result.completedAt = new Date().toISOString();
      result.durationMs = Date.now() - start;
    }

    return result;
  }

  /**
   * Resumes workflow after a human review is submitted.
   * Deterministic & idempotent: calling multiple times will not duplicate Followup.
   */
  async resumeAfterCopilotReview(incidentId: string): Promise<WorkflowResult> {
    const start = Date.now();
    this.incidentId = incidentId;

    const latestRun = await this.copilotRepo.getLatestCopilotRunByIncidentId(incidentId);
    if (!latestRun) {
      throw new Error(`No Copilot run found for incident '${incidentId}'`);
    }

    this.workflowId = latestRun.workflow_id;
    const activeReview = await this.copilotRepo.getActiveReviewByRunId(latestRun.id);

    const result: WorkflowResult = {
      workflowId: this.workflowId,
      incidentId,
      state: this.workflowState,
      startedAt: new Date(start).toISOString(),
      copilotResult: activeReview?.edited_result || latestRun.copilot_result,
    };

    if (!activeReview || activeReview.status === 'PENDING') {
      logger.info({
        component: 'AIWorkflowService',
        operation: 'resumeSkippedPending',
        workflowId: this.workflowId,
        incidentId,
        status: 'PENDING',
      });
      result.state = WorkflowState.COPILOT_AWAITING_REVIEW;
      return result;
    }

    // Idempotency check: if workflow has already moved past AWAITING_REVIEW
    if (
      this.workflowState === WorkflowState.COMPLETED ||
      this.workflowState === WorkflowState.COPILOT_REVIEW_REJECTED ||
      this.workflowState === WorkflowState.FOLLOWUP_RUNNING
    ) {
      logger.info({
        component: 'AIWorkflowService',
        operation: 'resumeSkippedAlreadyProcessed',
        workflowId: this.workflowId,
        incidentId,
        currentState: this.workflowState,
      });
      return result;
    }

    try {
      if (activeReview.status === 'APPROVED' || activeReview.status === 'EDITED') {
        const nextState =
          activeReview.status === 'APPROVED'
            ? WorkflowState.COPILOT_REVIEW_APPROVED
            : WorkflowState.COPILOT_REVIEW_EDITED;

        await this.transitionState(nextState);
        await this.transitionState(WorkflowState.FOLLOWUP_RUNNING);

        const followup = await this.followupService.runFollowupForIncident(incidentId);
        result.followupResult = followup;

        await this.transitionState(WorkflowState.COMPLETED);
        result.state = WorkflowState.COMPLETED;
      } else if (activeReview.status === 'REJECTED') {
        await this.transitionState(WorkflowState.COPILOT_REVIEW_REJECTED);
        result.state = WorkflowState.COPILOT_REVIEW_REJECTED;

        logger.info({
          component: 'AIWorkflowService',
          operation: 'workflowTerminatedRejected',
          workflowId: this.workflowId,
          incidentId,
          status: 'REJECTED',
        });
      }

      result.completedAt = new Date().toISOString();
      result.durationMs = Date.now() - start;
    } catch (err: unknown) {
      await this.transitionState(WorkflowState.FAILED, err);
      result.state = WorkflowState.FAILED;
      result.error = err instanceof Error ? err.message : String(err);
      result.completedAt = new Date().toISOString();
      result.durationMs = Date.now() - start;
    }

    return result;
  }

  private async transitionState(
    newState: WorkflowState,
    error?: unknown
  ): Promise<void> {
    if (this.cancelled && newState !== WorkflowState.CANCELLED) {
      return;
    }
    const previous = this.workflowState;
    this.workflowState = newState;
    const event: WorkflowEvent = {
      workflowId: this.workflowId,
      incidentId: this.incidentId,
      previousState: previous,
      currentState: newState,
      timestamp: new Date().toISOString(),
      durationMs: previous ? Date.now() - this.lastTransitionTime! : 0,
      errorCode: error instanceof Error ? error.message : undefined,
    };
    this.lastTransitionTime = Date.now();
    await this.emitEvent(event);
    logger.info({
      component: 'AIWorkflowService',
      operation: 'stateTransition',
      workflowId: this.workflowId,
      incidentId: this.incidentId,
      from: previous,
      to: newState,
    });
  }

  private async emitEvent(event?: WorkflowEvent, state?: WorkflowState): Promise<void> {
    if (event) {
      logger.info({ component: 'AIWorkflowService', operation: 'event', event });
    }
  }

  cancelWorkflow(): void {
    this.cancelled = true;
  }

  private workflowState: WorkflowState = WorkflowState.NEW;
  private lastTransitionTime?: number;
  private incidentId!: string;
}
