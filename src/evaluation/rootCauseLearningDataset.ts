export type LearningCauseCode = "STAFFING" | "CAPACITY" | "LINEHAUL" | "PROCESS" | "DATA_ERROR" | "OTHER" | "UNKNOWN";

export type LearningVerification = {
  id: string;
  incidentId: string;
  actualCause: LearningCauseCode;
  evidence: string;
  notes: string | null;
  verifiedBy: string;
  verifiedAt: string;
  warehouseName: string;
  incidentType: string;
};

export type LearningCopilotRun = {
  id: string;
  incidentId: string;
  promptId: string;
  promptVersion: string;
  provider: string | null;
  model: string | null;
  result: Record<string, unknown>;
  createdAt: string;
};

export type LearningCopilotReview = {
  runId: string;
  status: string;
  editedResult: Record<string, unknown> | null;
  reviewedBy: string | null;
  rating: number | null;
  comment: string | null;
  reviewedAt: string;
};

export type LearningDatasetExample = {
  exampleId: string;
  incidentId: string;
  warehouseName: string;
  incidentType: string;
  prompt: { id: string; version: string; provider: string; model: string };
  prediction: { text: string; causeCode: LearningCauseCode };
  groundTruth: { causeCode: LearningCauseCode; evidence: string; notes: string | null };
  review: { status: string; reviewedBy: string; rating: number | null; comment: string | null };
  evaluation: { comparable: boolean; exactCauseMatch: boolean | null };
  timestamps: { predictedAt: string; verifiedAt: string; reviewedAt: string };
};

export type LearningDatasetCandidate = {
  incidentId: string;
  warehouseName: string;
  incidentType: string;
  status: "ELIGIBLE" | "EXCLUDED";
  reasons: string[];
};

const terminalReviewStatuses = new Set(["APPROVED", "EDITED", "REJECTED"]);

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function extractRootCauseText(result: Record<string, unknown>) {
  const summary = objectValue(result.summary);
  return typeof summary.rootCause === "string" ? summary.rootCause.trim() : "";
}

export function classifyCauseText(text: string): LearningCauseCode {
  const normalized = text.toLocaleLowerCase("vi-VN");
  if (/shipper|nhân sự|thiếu người|staff/.test(normalized)) return "STAFFING";
  if (/diện tích|công suất|quá tải|sức chứa|capacity/.test(normalized)) return "CAPACITY";
  if (/trung chuyển|linehaul|xe.*trễ|chậm.*xe/.test(normalized)) return "LINEHAUL";
  if (/quy trình|process|thao tác|phân loại/.test(normalized)) return "PROCESS";
  if (/dữ liệu|đồng bộ|data|api|snapshot/.test(normalized)) return "DATA_ERROR";
  return "UNKNOWN";
}

export function buildRootCauseLearningDataset(input: {
  verifications: LearningVerification[];
  runs: LearningCopilotRun[];
  reviews: LearningCopilotReview[];
  generatedAt?: string;
}) {
  const latestVerification = new Map<string, LearningVerification>();
  for (const item of [...input.verifications].sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt))) {
    if (!latestVerification.has(item.incidentId)) latestVerification.set(item.incidentId, item);
  }
  const latestRun = new Map<string, LearningCopilotRun>();
  for (const item of [...input.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (!latestRun.has(item.incidentId)) latestRun.set(item.incidentId, item);
  }
  const reviewByRun = new Map(input.reviews.map((item) => [item.runId, item]));
  const examples: LearningDatasetExample[] = [];
  const candidates: LearningDatasetCandidate[] = [];

  for (const verification of latestVerification.values()) {
    const run = latestRun.get(verification.incidentId);
    const review = run ? reviewByRun.get(run.id) : undefined;
    const reasons: string[] = [];
    if (!verification.evidence.trim()) reasons.push("EMPTY_VERIFICATION_EVIDENCE");
    if (!run) reasons.push("COPILOT_RUN_MISSING");
    if (run && (!review || !terminalReviewStatuses.has(review.status))) reasons.push("TERMINAL_HUMAN_REVIEW_MISSING");
    candidates.push({
      incidentId: verification.incidentId,
      warehouseName: verification.warehouseName,
      incidentType: verification.incidentType,
      status: reasons.length === 0 ? "ELIGIBLE" : "EXCLUDED",
      reasons,
    });
    if (!run || !review || reasons.length > 0) continue;

    const effectiveResult = review.status === "EDITED" && review.editedResult ? review.editedResult : run.result;
    const predictedText = extractRootCauseText(effectiveResult);
    const predictedCode = classifyCauseText(predictedText);
    const comparable = predictedCode !== "UNKNOWN" && verification.actualCause !== "UNKNOWN";
    examples.push({
      exampleId: stableHash(`${verification.id}:${run.id}:${review.reviewedAt}`),
      incidentId: verification.incidentId,
      warehouseName: verification.warehouseName,
      incidentType: verification.incidentType,
      prompt: { id: run.promptId, version: run.promptVersion, provider: run.provider || "unknown", model: run.model || "unknown" },
      prediction: { text: predictedText, causeCode: predictedCode },
      groundTruth: { causeCode: verification.actualCause, evidence: verification.evidence, notes: verification.notes },
      review: { status: review.status, reviewedBy: review.reviewedBy || "unknown", rating: review.rating, comment: review.comment },
      evaluation: { comparable, exactCauseMatch: comparable ? predictedCode === verification.actualCause : null },
      timestamps: { predictedAt: run.createdAt, verifiedAt: verification.verifiedAt, reviewedAt: review.reviewedAt },
    });
  }

  examples.sort((a, b) => a.exampleId.localeCompare(b.exampleId));
  const comparable = examples.filter((item) => item.evaluation.comparable);
  const matches = comparable.filter((item) => item.evaluation.exactCauseMatch).length;
  const versionSeed = examples.map((item) => `${item.exampleId}:${item.review.status}:${item.groundTruth.causeCode}`).join("|");
  return {
    schemaVersion: "root-cause-learning/v1",
    datasetVersion: `rc-v1-${stableHash(versionSeed || "empty")}`,
    generatedAt: input.generatedAt || new Date().toISOString(),
    safeguards: {
      autoTraining: false,
      productionPromptMutation: false,
      autonomousExecution: false,
      eligibility: "latest verification with evidence + latest Copilot run + terminal active human review",
    },
    summary: {
      verificationCandidates: candidates.length,
      eligibleExamples: examples.length,
      excludedCandidates: candidates.filter((item) => item.status === "EXCLUDED").length,
      comparableExamples: comparable.length,
      exactCauseMatches: matches,
      exactCauseAgreement: comparable.length ? Number((matches / comparable.length).toFixed(4)) : null,
    },
    candidates,
    examples,
  };
}

export function serializeLearningDatasetJsonl(dataset: ReturnType<typeof buildRootCauseLearningDataset>) {
  return dataset.examples.map((example) => JSON.stringify({
    schemaVersion: dataset.schemaVersion,
    datasetVersion: dataset.datasetVersion,
    ...example,
  })).join("\n");
}
