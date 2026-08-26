import fs from "fs";
import path from "path";

export interface RootCauseExpectedOutput {
  primaryCause: string;
  expectedEvidenceCodes: string[];
  expectedConfidence: number;
  confidenceTolerance: number;
}

export interface RootCauseDatasetItem {
  id: string;
  name: string;
  incident: any;
  historyRows?: any[];
  expected: RootCauseExpectedOutput;
  mockAiResponse?: {
    primaryCause: string;
    contributingFactors: string[];
    evidenceCodes: string[];
    confidence: number;
    recommendedFocus: string;
  };
}

export interface PlannerExpectedOutput {
  expectedRecommendationCount: number;
  expectedTypes: string[];
  expectedTargetRoles: string[];
  expectedConfidence: number;
  confidenceTolerance: number;
}

export interface PlannerDatasetItem {
  id: string;
  name: string;
  incident: any;
  historyRows?: any[];
  rootCauseResult?: any;
  followupCase?: any;
  followupEvents?: any[];
  actionHistory?: any[];
  activeExceptions?: any[];
  expected: PlannerExpectedOutput;
  mockAiResponse?: {
    recommendations: Array<{
      type: string;
      targetRole: string;
      title: string;
      description: string;
      priority: string;
      estimatedImpact: string;
    }>;
    investigation: {
      requiredData: string[];
      keyQuestions: string[];
    };
  };
}

export function loadRootCauseDatasets(baseDir?: string): RootCauseDatasetItem[] {
  const datasetDir = baseDir || path.join(process.cwd(), "evaluation", "datasets", "rootcause");
  if (!fs.existsSync(datasetDir)) {
    return [];
  }
  const files = fs.readdirSync(datasetDir).filter((f) => f.endsWith(".json"));
  return files.map((file) => {
    const content = fs.readFileSync(path.join(datasetDir, file), "utf-8");
    return JSON.parse(content) as RootCauseDatasetItem;
  });
}

export function loadPlannerDatasets(baseDir?: string): PlannerDatasetItem[] {
  const datasetDir = baseDir || path.join(process.cwd(), "evaluation", "datasets", "planner");
  if (!fs.existsSync(datasetDir)) {
    return [];
  }
  const files = fs.readdirSync(datasetDir).filter((f) => f.endsWith(".json"));
  return files.map((file) => {
    const content = fs.readFileSync(path.join(datasetDir, file), "utf-8");
    return JSON.parse(content) as PlannerDatasetItem;
  });
}
