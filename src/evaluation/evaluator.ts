import { RootCauseAgent } from "../agents/root-cause";
import { ActionPlannerAgent } from "../agents/action-planner";
import * as aiModule from "../ai";
import {
  type RootCauseDatasetItem,
  type PlannerDatasetItem,
  loadRootCauseDatasets,
  loadPlannerDatasets,
} from "./dataset";
import {
  type EvaluationDifference,
  type EvaluationScoreResult,
  calculateEvidenceMatchScore,
  calculateSetInclusionScore,
  calculateToleranceScore,
} from "./score";

export interface IndividualEvalResult extends EvaluationScoreResult {
  id: string;
  name: string;
}

export interface SuiteEvalResult {
  passed: boolean;
  passCount: number;
  totalCount: number;
  averageScore: number;
  results: IndividualEvalResult[];
}

export async function evaluateRootCauseItem(
  item: RootCauseDatasetItem,
  agent?: RootCauseAgent
): Promise<IndividualEvalResult> {
  const rootCauseAgent = agent || new RootCauseAgent();

  // If mock AI response is provided in dataset item, mock the AI call
  let spy: any;
  if (item.mockAiResponse) {
    spy = viSpyGenerate(JSON.stringify(item.mockAiResponse));
  }

  try {
    const analysisRes = await rootCauseAgent.analyzeIncident(item.incident, item.historyRows || [], {
      forceRegenerate: true,
    });

    const differences: EvaluationDifference[] = [];
    let totalScoreSum = 0;

    // 1. Primary Cause Check (Weight: 40%)
    const actualCauses = analysisRes.analysis.causes || [];
    const actualPrimary = actualCauses.length > 0 ? actualCauses[0].title : analysisRes.analysis.summary || "";
    const expectedPrimary = item.expected.primaryCause;
    let causeScore = 100;
    if (!actualPrimary || !actualPrimary.toLowerCase().includes(expectedPrimary.toLowerCase())) {
      causeScore = 0;
      differences.push({
        field: "primaryCause",
        expected: expectedPrimary,
        actual: actualPrimary,
        message: `Primary cause '${actualPrimary}' did not contain expected snippet '${expectedPrimary}'`,
      });
    }
    totalScoreSum += causeScore * 0.4;

    // 2. Evidence Codes Match (Weight: 40%)
    const actualCodes = analysisRes.evidence.map((e) => e.code);
    const evEval = calculateEvidenceMatchScore(item.expected.expectedEvidenceCodes, actualCodes);
    differences.push(...evEval.differences);
    totalScoreSum += evEval.score * 0.4;

    // 3. Confidence Tolerance Check (Weight: 20%)
    const confEval = calculateToleranceScore(
      "confidence",
      item.expected.expectedConfidence,
      analysisRes.analysis.confidence,
      item.expected.confidenceTolerance
    );
    differences.push(...confEval.differences);
    totalScoreSum += confEval.score * 0.2;

    const finalScore = Math.round(totalScoreSum);
    const passed = finalScore >= 80 && differences.length === 0;

    return {
      id: item.id,
      name: item.name,
      score: finalScore,
      passed,
      differences,
    };
  } finally {
    if (spy) {
      spy.mockRestore();
    }
  }
}

export async function evaluatePlannerItem(
  item: PlannerDatasetItem,
  agent?: ActionPlannerAgent
): Promise<IndividualEvalResult> {
  const plannerAgent = agent || new ActionPlannerAgent(null);

  let spy: any;
  if (item.mockAiResponse) {
    spy = viSpyGenerate(JSON.stringify(item.mockAiResponse));
  }

  try {
    const plannerRes = await plannerAgent.analyzeIncident({
      incident: item.incident,
      historyRows: item.historyRows || [],
      rootCauseResult: item.rootCauseResult || null,
      followupCase: item.followupCase || null,
      followupEvents: item.followupEvents || [],
      actionHistory: item.actionHistory || [],
      activeExceptions: item.activeExceptions || [],
      options: { forceRegenerate: true, requestedBy: "evaluator" },
    });

    const differences: EvaluationDifference[] = [];
    let totalScoreSum = 0;

    // 1. Recommendation Count Score (Weight: 25%)
    const recs = plannerRes.result.recommendations || [];
    const countEval = calculateToleranceScore(
      "recommendationCount",
      item.expected.expectedRecommendationCount,
      recs.length,
      1
    );
    differences.push(...countEval.differences);
    totalScoreSum += countEval.score * 0.25;

    // 2. Recommendation Types Score (Weight: 30%)
    const actualTypes = recs.map((r) => r.type);
    const typeEval = calculateSetInclusionScore("recommendationTypes", item.expected.expectedTypes, actualTypes);
    differences.push(...typeEval.differences);
    totalScoreSum += typeEval.score * 0.3;

    // 3. Target Roles Score (Weight: 25%)
    const actualRoles = recs.map((r) => r.targetRole);
    const roleEval = calculateSetInclusionScore("targetRoles", item.expected.expectedTargetRoles, actualRoles);
    differences.push(...roleEval.differences);
    totalScoreSum += roleEval.score * 0.25;

    // 4. Confidence Tolerance Check (Weight: 20%)
    const actualConfidenceScore =
      typeof plannerRes.result.confidence === "number"
        ? plannerRes.result.confidence
        : typeof plannerRes.result.confidence?.score === "number"
        ? plannerRes.result.confidence.score
        : 85;

    const confEval = calculateToleranceScore(
      "confidence",
      item.expected.expectedConfidence,
      actualConfidenceScore,
      item.expected.confidenceTolerance
    );
    differences.push(...confEval.differences);
    totalScoreSum += confEval.score * 0.2;

    const finalScore = Math.round(totalScoreSum);
    const passed = finalScore >= 80 && differences.length === 0;

    return {
      id: item.id,
      name: item.name,
      score: finalScore,
      passed,
      differences,
    };
  } finally {
    if (spy) {
      spy.mockRestore();
    }
  }
}

export async function evaluateRootCauseSuite(baseDir?: string): Promise<SuiteEvalResult> {
  const items = loadRootCauseDatasets(baseDir);
  const results: IndividualEvalResult[] = [];

  for (const item of items) {
    const res = await evaluateRootCauseItem(item);
    results.push(res);
  }

  const passCount = results.filter((r) => r.passed).length;
  const totalScore = results.reduce((acc, r) => acc + r.score, 0);
  const averageScore = results.length > 0 ? Math.round(totalScore / results.length) : 0;

  return {
    passed: passCount === results.length && results.length > 0,
    passCount,
    totalCount: results.length,
    averageScore,
    results,
  };
}

export async function evaluatePlannerSuite(baseDir?: string): Promise<SuiteEvalResult> {
  const items = loadPlannerDatasets(baseDir);
  const results: IndividualEvalResult[] = [];

  for (const item of items) {
    const res = await evaluatePlannerItem(item);
    results.push(res);
  }

  const passCount = results.filter((r) => r.passed).length;
  const totalScore = results.reduce((acc, r) => acc + r.score, 0);
  const averageScore = results.length > 0 ? Math.round(totalScore / results.length) : 0;

  return {
    passed: passCount === results.length && results.length > 0,
    passCount,
    totalCount: results.length,
    averageScore,
    results,
  };
}

import { registerAIProvider } from "../ai/provider";

function viSpyGenerate(responseText: string): any {
  const mockProvider = {
    name: "eval-mock",
    generate: async () => ({
      text: responseText,
      provider: "eval-mock",
      model: "golden-dataset-model",
    }),
  };
  registerAIProvider(mockProvider);
  const oldEnv = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = "eval-mock";

  return {
    mockRestore: () => {
      process.env.AI_PROVIDER = oldEnv;
    },
  };
}
