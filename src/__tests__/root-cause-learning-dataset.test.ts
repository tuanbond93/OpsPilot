import { describe, expect, it } from "vitest";
import { buildRootCauseLearningDataset, classifyCauseText, serializeLearningDatasetJsonl } from "../evaluation/rootCauseLearningDataset";

const verification = { id: "v1", incidentId: "i1", actualCause: "STAFFING" as const, evidence: "Ca trực thiếu 3 người", notes: null, verifiedBy: "ops", verifiedAt: "2026-08-23T02:00:00Z", warehouseName: "Kho A", incidentType: "Kho tồn" };
const run = { id: "r1", incidentId: "i1", promptId: "copilot", promptVersion: "v1", provider: "openai", model: "model", result: { summary: { rootCause: "Thiếu shipper trong ca" } }, createdAt: "2026-08-23T01:00:00Z" };
const review = { runId: "r1", status: "APPROVED", editedResult: null, reviewedBy: "manager", rating: 4, comment: null, reviewedAt: "2026-08-23T03:00:00Z" };

describe("root cause learning dataset", () => {
  it("only includes verified cases with a terminal human review", () => {
    const eligible = buildRootCauseLearningDataset({ verifications: [verification], runs: [run], reviews: [review], generatedAt: "fixed" });
    expect(eligible.summary.eligibleExamples).toBe(1);
    expect(eligible.summary.exactCauseAgreement).toBe(1);
    const excluded = buildRootCauseLearningDataset({ verifications: [verification], runs: [run], reviews: [], generatedAt: "fixed" });
    expect(excluded.summary.eligibleExamples).toBe(0);
    expect(excluded.candidates[0].reasons).toContain("TERMINAL_HUMAN_REVIEW_MISSING");
  });

  it("uses an edited human-reviewed result and does not force unknown predictions", () => {
    const dataset = buildRootCauseLearningDataset({ verifications: [verification], runs: [run], reviews: [{ ...review, status: "EDITED", editedResult: { summary: { rootCause: "Chưa đủ bằng chứng" } } }] });
    expect(dataset.examples[0].prediction.causeCode).toBe("UNKNOWN");
    expect(dataset.examples[0].evaluation.exactCauseMatch).toBeNull();
  });

  it("deduplicates by incident, versions deterministically, and exports JSONL", () => {
    const older = { ...verification, id: "v0", actualCause: "PROCESS" as const, verifiedAt: "2026-08-22T02:00:00Z" };
    const first = buildRootCauseLearningDataset({ verifications: [older, verification], runs: [run], reviews: [review], generatedAt: "a" });
    const second = buildRootCauseLearningDataset({ verifications: [verification, older], runs: [run], reviews: [review], generatedAt: "b" });
    expect(first.examples).toHaveLength(1);
    expect(first.datasetVersion).toBe(second.datasetVersion);
    const parsed = JSON.parse(serializeLearningDatasetJsonl(first));
    expect(parsed.datasetVersion).toBe(first.datasetVersion);
    expect(parsed.groundTruth.evidence).toBe("Ca trực thiếu 3 người");
  });

  it("classifies supported causes with deterministic evidence rules", () => {
    expect(classifyCauseText("Xe trung chuyển đến trễ")).toBe("LINEHAUL");
    expect(classifyCauseText("Không đủ thông tin")).toBe("UNKNOWN");
  });
});
