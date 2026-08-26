import { describe, it, expect, beforeEach } from "vitest";
import { calculateHumanAgreement } from "@/evaluation/humanAgreementEngine";
import { buildProductionDataset } from "@/evaluation/productionDataset";
import { calculateConfidenceCalibration } from "@/evaluation/confidenceCalibration";
import { comparePromptsAndModels } from "@/evaluation/copilotComparison";
import { MockCopilotRepository } from "@/repositories/mock/MockCopilotRepository";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";
import { CopilotService } from "@/services/impl/CopilotService";
import { CopilotQualityService } from "@/services/impl/CopilotQualityService";
import type { CopilotLearningRecord } from "@/ai/copilotReviewTypes";

describe("Sprint 12.3 — Production AI Evaluation & Human Agreement Engine", () => {
  let copilotRepo: MockCopilotRepository;
  let copilotService: CopilotService;
  let qualityService: CopilotQualityService;

  beforeEach(() => {
    RepositoryFactory.clear();
    copilotRepo = new MockCopilotRepository();
    RepositoryFactory.registerCopilotRepository(copilotRepo);
    copilotService = new CopilotService(copilotRepo);
    qualityService = new CopilotQualityService(copilotRepo);
  });

  describe("Human Agreement Engine", () => {
    it("returns 100 agreement for APPROVED status", () => {
      const orig = { executiveSummary: "Delay due to inventory", confidence: 0.9 };
      const agreement = calculateHumanAgreement(orig, orig, "APPROVED");

      expect(agreement.overallAgreement).toBe(100);
      expect(agreement.weightedAgreement).toBe(100);
      expect(agreement.rootCauseAgreement).toBe(100);
    });

    it("returns 0 agreement for REJECTED status", () => {
      const orig = { executiveSummary: "Wrong reason", confidence: 0.9 };
      const agreement = calculateHumanAgreement(orig, null, "REJECTED");

      expect(agreement.overallAgreement).toBe(0);
      expect(agreement.weightedAgreement).toBe(0);
    });

    it("calculates partial agreement for EDITED status", () => {
      const orig = {
        summary: {
          description: "Minor warehouse backlog detected",
          rootCause: "Packing bottleneck at station 3",
          recommendedActions: ["Add staff", "Notify CS"],
        },
        confidence: 0.85,
      };

      const edited = {
        summary: {
          description: "Minor warehouse backlog detected",
          rootCause: "Packing bottleneck at station 4",
          recommendedActions: ["Add staff"],
        },
        confidence: 0.80,
      };

      const agreement = calculateHumanAgreement(orig, edited, "EDITED");
      expect(agreement.executiveSummaryAgreement).toBe(100);
      expect(agreement.overallAgreement).toBeGreaterThan(0);
      expect(agreement.overallAgreement).toBeLessThan(100);
      expect(agreement.weightedAgreement).toBeGreaterThan(0);
    });
  });

  describe("Production Dataset Builder & Prompt/Model Comparisons", () => {
    it("builds normalized production dataset and prompt/model comparisons", () => {
      const records: CopilotLearningRecord[] = [
        {
          incidentId: "inc-1",
          runId: "run-1",
          workflowId: "wf-1",
          promptId: "copilot",
          promptVersion: "v1",
          provider: "openai",
          model: "gpt-4o",
          originalResult: { executiveSummary: "Issue 1", confidence: 0.9 },
          humanApprovedResult: { executiveSummary: "Issue 1", confidence: 0.9 },
          status: "APPROVED",
          rating: 5,
          comment: null,
          reviewedAt: "2026-08-07T10:00:00Z",
        },
        {
          incidentId: "inc-2",
          runId: "run-2",
          workflowId: "wf-2",
          promptId: "copilot",
          promptVersion: "v2",
          provider: "gemini",
          model: "gemini-3.6",
          originalResult: { executiveSummary: "Issue 2", confidence: 0.6 },
          humanApprovedResult: null,
          status: "REJECTED",
          rating: 1,
          comment: "Bad suggestion",
          reviewedAt: "2026-08-07T11:00:00Z",
        },
      ];

      const dataset = buildProductionDataset(records);
      expect(dataset.totalRecords).toBe(2);
      expect(dataset.approvedCount).toBe(1);
      expect(dataset.rejectedCount).toBe(1);
      expect(dataset.overallAverageAgreement).toBe(50);

      const comp = comparePromptsAndModels(dataset.records);
      expect(comp.promptVersionComparison.length).toBe(2);
      expect(comp.modelComparison.length).toBe(2);

      const v1Comp = comp.promptVersionComparison.find((p) => p.versionOrModel === "copilot@v1");
      expect(v1Comp?.approvalRate).toBe(1);

      const v2Comp = comp.promptVersionComparison.find((p) => p.versionOrModel === "copilot@v2");
      expect(v2Comp?.rejectionRate).toBe(1);
    });
  });

  describe("Confidence Calibration", () => {
    it("does not report perfect calibration without evidence", () => {
      const calibration = calculateConfidenceCalibration([]);
      expect(calibration.totalEvaluated).toBe(0);
      expect(calibration.calibrationScore).toBe(0);
    });

    it("measures overconfidence and underconfidence rates correctly", () => {
      const records: import("@/evaluation/productionDataset").ProductionEvaluationRecord[] = [
        {
          incidentId: "inc-cal-1",
          runId: "run-cal-1",
          workflowId: "wf-cal-1",
          promptId: "copilot",
          promptVersion: "v1",
          provider: "openai",
          model: "gpt-4o",
          status: "REJECTED",
          rating: 1,
          comment: null,
          originalResult: { confidence: 0.9 }, // High confidence rejected = Overconfidence
          humanApprovedResult: null,
          agreementScores: calculateHumanAgreement({ confidence: 0.9 }, null, "REJECTED"),
          reviewedAt: "2026-08-07T10:00:00Z",
        },
        {
          incidentId: "inc-cal-2",
          runId: "run-cal-2",
          workflowId: "wf-cal-2",
          promptId: "copilot",
          promptVersion: "v1",
          provider: "openai",
          model: "gpt-4o",
          status: "APPROVED",
          rating: 5,
          comment: null,
          originalResult: { confidence: 0.4 }, // Low confidence approved = Underconfidence
          humanApprovedResult: { confidence: 0.4 },
          agreementScores: calculateHumanAgreement({ confidence: 0.4 }, { confidence: 0.4 }, "APPROVED"),
          reviewedAt: "2026-08-07T11:00:00Z",
        },
      ];

      const cal = calculateConfidenceCalibration(records);
      expect(cal.totalEvaluated).toBe(2);
      expect(cal.highConfidenceRejected).toBe(1);
      expect(cal.lowConfidenceApproved).toBe(1);
      expect(cal.overconfidenceRate).toBe(1.0);
      expect(cal.underconfidenceRate).toBe(1.0);
      expect(cal.calibrationCurve.length).toBe(5);
    });
  });

  describe("CopilotQualityService & History Aggregation", () => {
    it("does not fabricate a perfect quality score without human reviews", async () => {
      const summaryRes = await qualityService.getQualitySummary();
      expect(summaryRes.ok).toBe(true);
      expect(summaryRes.summary?.totalEvaluated).toBe(0);
      expect(summaryRes.summary?.overallQualityScore).toBeNull();
      expect(summaryRes.summary?.releaseReadinessScore).toBeNull();
    });

    it("returns complete quality summary and historical trend aggregation", async () => {
      await copilotRepo.createCopilotRun({
        id: "r1",
        incident_id: "inc-q1",
        workflow_id: "wf-q1",
        prompt_id: "copilot",
        prompt_version: "v1",
        copilot_result: { summary: "R1", confidence: 0.9 },
      });
      await copilotService.reviewCopilotRun("inc-q1", { status: "APPROVED", rating: 5 });

      await copilotRepo.createCopilotRun({
        id: "r2",
        incident_id: "inc-q2",
        workflow_id: "wf-q2",
        prompt_id: "copilot",
        prompt_version: "v1",
        copilot_result: { summary: "R2", confidence: 0.8 },
      });
      await copilotService.reviewCopilotRun("inc-q2", {
        status: "EDITED",
        editedResult: { summary: "R2 Edited", confidence: 0.8 },
        rating: 4,
      });

      const summaryRes = await qualityService.getQualitySummary();
      expect(summaryRes.ok).toBe(true);
      const summary = summaryRes.summary!;
      expect(summary.totalEvaluated).toBe(2);
      expect(summary.overallQualityScore!).toBeGreaterThan(0);
      expect(summary.releaseReadinessScore!).toBeGreaterThan(0);
      expect(summary.reviewMetrics.approvalRate).toBe(0.5);
      expect(summary.reviewMetrics.editRate).toBe(0.5);
      expect(summary.agreementMetrics.overallAgreement).toBeGreaterThan(0);

      const historyRes = await qualityService.getQualityHistory();
      expect(historyRes.ok).toBe(true);
      expect(historyRes.history?.length).toBeGreaterThan(0);
    });
  });
});
