import { describe, it, expect, beforeEach } from 'vitest';
import { MockCopilotRepository } from '@/repositories/mock/MockCopilotRepository';
import { MockIncidentRepository } from '@/repositories/mock/MockIncidentRepository';
import { RepositoryFactory } from '@/repositories/RepositoryFactory';
import { ServiceFactory } from '@/services/ServiceFactory';
import { CopilotService } from '@/services/impl/CopilotService';
import { AIWorkflowService } from '@/workflow/AIWorkflowService';
import { WorkflowState } from '@/workflow/WorkflowState';

describe('Sprint 12.2 — Copilot Human Feedback Loop & Persistence', () => {
  let copilotRepo: MockCopilotRepository;
  let copilotService: CopilotService;

  beforeEach(() => {
    RepositoryFactory.clear();
    copilotRepo = new MockCopilotRepository();
    RepositoryFactory.registerCopilotRepository(copilotRepo);
    copilotService = new CopilotService(copilotRepo);
  });

  describe('Repository & Active Review Persistence', () => {
    it('creates copilot run and persists original AI result immutably', async () => {
      const run = await copilotRepo.createCopilotRun({
        incident_id: 'inc-101',
        workflow_id: 'wf-101',
        copilot_result: { summary: 'Original AI summary', confidence: 0.95 },
      });

      expect(run.id).toBeDefined();
      expect(run.incident_id).toBe('inc-101');

      const fetched = await copilotRepo.getLatestCopilotRunByIncidentId('inc-101');
      expect(fetched?.copilot_result).toEqual({ summary: 'Original AI summary', confidence: 0.95 });
    });

    it('enforces one active review per run_id and supersedes older reviews', async () => {
      const run = await copilotRepo.createCopilotRun({
        incident_id: 'inc-102',
        workflow_id: 'wf-102',
        copilot_result: { summary: 'AI draft' },
      });

      const rev1 = await copilotRepo.createReview({
        run_id: run.id,
        incident_id: 'inc-102',
        workflow_id: 'wf-102',
        status: 'APPROVED',
        is_active: true,
      });

      expect(rev1.is_active).toBe(true);
      expect(rev1.status).toBe('APPROVED');

      // Submit second review for same run
      const rev2 = await copilotRepo.createReview({
        run_id: run.id,
        incident_id: 'inc-102',
        workflow_id: 'wf-102',
        status: 'EDITED',
        edited_result: { summary: 'Human edited summary' },
        is_active: true,
      });

      expect(rev2.is_active).toBe(true);
      expect(rev2.status).toBe('EDITED');

      // Verify rev1 is superseded
      const history = await copilotRepo.listReviewsByRunId(run.id);
      expect(history.length).toBe(2);

      const active = await copilotRepo.getActiveReviewByRunId(run.id);
      expect(active?.id).toBe(rev2.id);
      expect(active?.status).toBe('EDITED');

      const superseded = history.find((r) => r.id === rev1.id);
      expect(superseded?.is_active).toBe(false);
      expect(superseded?.status).toBe('SUPERSEDED');
    });
  });

  describe('CopilotService Validation & Review Business Logic', () => {
    it('rejects invalid review status', async () => {
      const res = await copilotService.reviewCopilotRun(
        'inc-103',
        { status: 'INVALID' as any }
      );
      expect(res.ok).toBe(false);
      expect(res.error).toBe('InvalidStatus');
    });

    it('requires editedResult when status is EDITED', async () => {
      await copilotRepo.createCopilotRun({
        incident_id: 'inc-104',
        workflow_id: 'wf-104',
        copilot_result: { summary: 'Original' },
      });

      const res = await copilotService.reviewCopilotRun('inc-104', {
        status: 'EDITED',
        editedResult: null,
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe('MissingEditedResult');
    });

    it('rejects invalid rating values', async () => {
      await copilotRepo.createCopilotRun({
        incident_id: 'inc-105',
        workflow_id: 'wf-105',
        copilot_result: { summary: 'Original' },
      });

      const res = await copilotService.reviewCopilotRun('inc-105', {
        status: 'APPROVED',
        rating: 10 as any,
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe('InvalidRating');
    });

    it('preserves original AI result immutably when review status is EDITED', async () => {
      const originalResult = { summary: 'AI summary', actions: ['action1'] };
      const run = await copilotRepo.createCopilotRun({
        incident_id: 'inc-106',
        workflow_id: 'wf-106',
        copilot_result: originalResult,
      });

      const editedResult = { summary: 'Human corrected summary', actions: ['action1', 'action2'] };
      const res = await copilotService.reviewCopilotRun(
        'inc-106',
        { status: 'EDITED', editedResult, rating: 4, comment: 'Fixed summary' },
        'operator-1'
      );

      expect(res.ok).toBe(true);

      const runInDb = await copilotRepo.getCopilotRunById(run.id);
      expect(runInDb?.copilot_result).toEqual(originalResult); // Must remain untouched

      const activeRev = await copilotRepo.getActiveReviewByRunId(run.id);
      expect(activeRev?.edited_result).toEqual(editedResult);
    });
  });

  describe('Workflow Pause & Deterministic Resume Idempotency', () => {
    it('pauses workflow at COPILOT_AWAITING_REVIEW and resumes after APPROVED review', async () => {
      const workflow = new AIWorkflowService('wf-pause-1');
      // Note: IncidentService analyzeRootCause requires mock incident in repository if full pipeline runs
      // Let's seed mock incident for full pipeline test
      const incidentRepo = RepositoryFactory.getIncidentRepository() as MockIncidentRepository;
      incidentRepo.seed([
        {
          id: 'inc-pause-1',
          incident_key: 'KEY-1',
          warehouse_id: 'WH-1',
          warehouse_name: 'Warehouse 1',
          reason_code: 'MISSING_PACKAGE',
          reason_name: 'Missing Package',
          status: 'open',
          priority_score: 50,
          first_detected_at: new Date().toISOString(),
          last_detected_at: new Date().toISOString(),
        },
      ]);

      const execRes = await workflow.execute('inc-pause-1');
      expect(execRes.state).toBe(WorkflowState.COPILOT_AWAITING_REVIEW);

      const run = await copilotRepo.getLatestCopilotRunByIncidentId('inc-pause-1');
      expect(run).toBeDefined();

      const activePending = await copilotRepo.getActiveReviewByRunId(run!.id);
      expect(activePending?.status).toBe('PENDING');

      // Operator submits review
      const reviewRes = await copilotService.reviewCopilotRun(
        'inc-pause-1',
        { status: 'APPROVED', rating: 5, comment: 'Looks good' },
        'lead-operator'
      );

      expect(reviewRes.ok).toBe(true);
      expect(reviewRes.resumedState).toBe(WorkflowState.COMPLETED);

      // Verify calling resume again is idempotent
      const duplicateResume = await workflow.resumeAfterCopilotReview('inc-pause-1');
      expect(duplicateResume.state).toBe(WorkflowState.COMPLETED);
    });

    it('terminates workflow cleanly without running Followup when review is REJECTED', async () => {
      const incidentRepo = RepositoryFactory.getIncidentRepository() as MockIncidentRepository;
      incidentRepo.seed([
        {
          id: 'inc-reject-1',
          incident_key: 'KEY-REJ',
          warehouse_id: 'WH-1',
          warehouse_name: 'Warehouse 1',
          reason_code: 'DAMAGED',
          reason_name: 'Damaged Item',
          status: 'open',
          priority_score: 80,
          first_detected_at: new Date().toISOString(),
          last_detected_at: new Date().toISOString(),
        },
      ]);

      const workflow = new AIWorkflowService('wf-reject-1');
      await workflow.execute('inc-reject-1');

      const reviewRes = await copilotService.reviewCopilotRun(
        'inc-reject-1',
        { status: 'REJECTED', comment: 'Incorrect analysis' },
        'senior-auditor'
      );

      expect(reviewRes.ok).toBe(true);
      expect(reviewRes.resumedState).toBe(WorkflowState.COPILOT_REVIEW_REJECTED);
    });
  });

  describe('Metrics & Learning Dataset Derivation', () => {
    it('calculates metrics accurately and derives supervised learning records', async () => {
      await copilotRepo.createCopilotRun({
        id: 'run-m1',
        incident_id: 'inc-m1',
        workflow_id: 'wf-m1',
        copilot_result: { summary: 'Run 1' },
      });
      await copilotService.reviewCopilotRun('inc-m1', { status: 'APPROVED', rating: 5 });

      await copilotRepo.createCopilotRun({
        id: 'run-m2',
        incident_id: 'inc-m2',
        workflow_id: 'wf-m2',
        copilot_result: { summary: 'Run 2' },
      });
      await copilotService.reviewCopilotRun('inc-m2', {
        status: 'EDITED',
        editedResult: { summary: 'Edited Run 2' },
        rating: 3,
      });

      await copilotRepo.createCopilotRun({
        id: 'run-m3',
        incident_id: 'inc-m3',
        workflow_id: 'wf-m3',
        copilot_result: { summary: 'Run 3' },
      });
      await copilotService.reviewCopilotRun('inc-m3', { status: 'REJECTED', rating: 1 });

      const metricsRes = await copilotService.getFeedbackMetrics();
      expect(metricsRes.ok).toBe(true);
      const metrics = metricsRes.metrics!;
      expect(metrics.totalReviews).toBe(3);
      expect(metrics.approvalRate).toBeCloseTo(0.3333, 2);
      expect(metrics.editRate).toBeCloseTo(0.3333, 2);
      expect(metrics.rejectionRate).toBeCloseTo(0.3333, 2);
      expect(metrics.averageRating).toBe(3);

      const datasetRes = await copilotService.getLearningDataset();
      expect(datasetRes.ok).toBe(true);
      const records = datasetRes.records!;
      expect(records.length).toBe(3);

      const editedRec = records.find((r) => r.incidentId === 'inc-m2');
      expect(editedRec?.humanApprovedResult).toEqual({ summary: 'Edited Run 2' });
      expect(editedRec?.originalResult).toEqual({ summary: 'Run 2' });

      const rejectedRec = records.find((r) => r.incidentId === 'inc-m3');
      expect(rejectedRec?.humanApprovedResult).toBeNull();
    });
  });
});
