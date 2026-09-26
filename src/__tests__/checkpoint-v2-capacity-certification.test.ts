import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { CapacityLoadGenerator, type CapacityBenchmarkResult } from "@/engine/checkpoint-v2/capacity-generator";

describe("Checkpoint Pipeline V2 - Large-Scale Capacity Certification Suite", () => {
  const benchmarkResults: CapacityBenchmarkResult[] = [];

  it("executes Scenario S1: 10,000 orders across profiles", async () => {
    const resA = await CapacityLoadGenerator.benchmark({
      scenarioName: "S1_10K_NORMAL",
      orderCount: 10_000,
      profile: "PROFILE_A_NORMAL",
      checkpointAt: "2026-09-26T07:00:00.000Z",
      syncRunId: "run_s1_normal",
    });
    expect(resA.passedAcceptanceGate).toBe(true);
    expect(resA.totalWorkUnits).toBeGreaterThan(10);
    expect(resA.maxWorkerDurationMs).toBeLessThan(180_000);
    benchmarkResults.push(resA);

    const resB = await CapacityLoadGenerator.benchmark({
      scenarioName: "S1_10K_HIGH_BACKLOG",
      orderCount: 10_000,
      profile: "PROFILE_B_HIGH_BACKLOG",
      checkpointAt: "2026-09-26T07:00:00.000Z",
      syncRunId: "run_s1_high",
    });
    expect(resB.passedAcceptanceGate).toBe(true);
    benchmarkResults.push(resB);
  });

  it("executes Scenario S2: 30,000 orders across profiles", async () => {
    const resA = await CapacityLoadGenerator.benchmark({
      scenarioName: "S2_30K_NORMAL",
      orderCount: 30_000,
      profile: "PROFILE_A_NORMAL",
      checkpointAt: "2026-09-26T07:00:00.000Z",
      syncRunId: "run_s2_normal",
    });
    expect(resA.passedAcceptanceGate).toBe(true);
    expect(resA.totalWorkUnits).toBeGreaterThan(30);
    expect(resA.maxWorkerDurationMs).toBeLessThan(180_000);
    benchmarkResults.push(resA);
  });

  it("executes Scenario S3: 50,000 orders across profiles", async () => {
    const resA = await CapacityLoadGenerator.benchmark({
      scenarioName: "S3_50K_NORMAL",
      orderCount: 50_000,
      profile: "PROFILE_A_NORMAL",
      checkpointAt: "2026-09-26T07:00:00.000Z",
      syncRunId: "run_s3_normal",
    });
    expect(resA.passedAcceptanceGate).toBe(true);
    expect(resA.totalWorkUnits).toBeGreaterThan(50);
    expect(resA.maxWorkerDurationMs).toBeLessThan(180_000);
    benchmarkResults.push(resA);

    const resC = await CapacityLoadGenerator.benchmark({
      scenarioName: "S3_50K_WORST_DAY",
      orderCount: 50_000,
      profile: "PROFILE_C_WORST_DAY",
      checkpointAt: "2026-09-26T07:00:00.000Z",
      syncRunId: "run_s3_worst",
    });
    expect(resC.passedAcceptanceGate).toBe(true);
    benchmarkResults.push(resC);
  });

  it("executes Scenario S4: 100,000 orders and proves bounded worker runtime", async () => {
    const resA = await CapacityLoadGenerator.benchmark({
      scenarioName: "S4_100K_NORMAL",
      orderCount: 100_000,
      profile: "PROFILE_A_NORMAL",
      checkpointAt: "2026-09-26T07:00:00.000Z",
      syncRunId: "run_s4_normal",
    });

    expect(resA.passedAcceptanceGate).toBe(true);
    expect(resA.totalWorkUnits).toBeGreaterThan(100);

    // Hard requirement: max worker runtime strictly bounded, far below 300s platform ceiling
    expect(resA.maxWorkerDurationMs).toBeLessThan(180_000);
    expect(resA.p95WorkerDurationMs).toBeLessThan(120_000);
    expect(resA.duplicateCommittedRows).toBe(0);
    expect(resA.duplicateDispatches).toBe(0);
    expect(resA.duplicateTelegramMessages).toBe(0);

    benchmarkResults.push(resA);

    const resB = await CapacityLoadGenerator.benchmark({
      scenarioName: "S4_100K_HIGH_BACKLOG",
      orderCount: 100_000,
      profile: "PROFILE_B_HIGH_BACKLOG",
      checkpointAt: "2026-09-26T07:00:00.000Z",
      syncRunId: "run_s4_high",
    });
    expect(resB.passedAcceptanceGate).toBe(true);
    benchmarkResults.push(resB);

    const resC = await CapacityLoadGenerator.benchmark({
      scenarioName: "S4_100K_WORST_DAY",
      orderCount: 100_000,
      profile: "PROFILE_C_WORST_DAY",
      checkpointAt: "2026-09-26T07:00:00.000Z",
      syncRunId: "run_s4_worst",
    });
    expect(resC.passedAcceptanceGate).toBe(true);
    benchmarkResults.push(resC);

    // Save benchmark artifacts to disk
    const artifactsDir = path.resolve(process.cwd(), "artifacts");
    if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(
      path.join(artifactsDir, "capacity-results.json"),
      JSON.stringify(benchmarkResults, null, 2),
      "utf8"
    );

    // Also persist in conversation artifacts
    const brainArtifactsDir = "C:/Users/Son-Tuan Nguyen/.gemini/antigravity/brain/a0109317-ac4e-48dc-8ca4-6913716ec0df";
    if (fs.existsSync(brainArtifactsDir)) {
      fs.writeFileSync(
        path.join(brainArtifactsDir, "capacity-results.json"),
        JSON.stringify(benchmarkResults, null, 2),
        "utf8"
      );
    }
  });
});
