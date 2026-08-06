import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

describe("Sprint 10.4.1 — Real Cross-Process Sync Recovery Tests", { timeout: 30000 }, () => {
  const runCrossProcessTest = (lastCompletedPhase: string) => {
    const output = execSync(`npx tsx scratch/run-cross-process-worker.ts --phase=${lastCompletedPhase}`, {
      encoding: "utf-8",
      cwd: "d:/Project/OpsPilot",
    });

    const jsonLine = output.split("\n").find((l) => l.includes("RESULT_JSON:"));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse((jsonLine || "").replace("RESULT_JSON:", "").trim());
    return { output, parsed };
  };

  it("1. crash after FETCHING_SNAPSHOT (safely replays snapshot fetch)", () => {
    const { parsed } = runCrossProcessTest("FETCHING_SNAPSHOT");
    expect(parsed.ok).toBe(true);
  });

  it("2. crash after PERSISTING_SNAPSHOTS (safely replays snapshot fetch due to empty RAM)", () => {
    const { parsed, output } = runCrossProcessTest("PERSISTING_SNAPSHOTS");
    expect(parsed.ok).toBe(true);
    expect(output).toContain("reason=SNAPSHOT_DATA_NOT_IN_MEMORY");
  });

  it("3. crash after PERSISTING_INCIDENTS (rehydrates incidents from DB)", () => {
    const { parsed, output } = runCrossProcessTest("PERSISTING_INCIDENTS");
    expect(parsed.ok).toBe(true);
    expect(parsed.incidentCount).toBe(1);
    expect(output).toContain("[SyncResume]");
  });

  it("4. crash after PERSISTING_HISTORY (rehydrates incidents & resumes history/followup)", () => {
    const { parsed, output } = runCrossProcessTest("PERSISTING_HISTORY");
    expect(parsed.ok).toBe(true);
    expect(parsed.incidentCount).toBe(1);
    expect(output).toContain("[SyncResume]");
  });

  it("5. crash after PROCESSING_FOLLOWUPS (rehydrates incidents & runs remaining steps)", () => {
    const { parsed, output } = runCrossProcessTest("PROCESSING_FOLLOWUPS");
    expect(parsed.ok).toBe(true);
    expect(parsed.incidentCount).toBe(1);
    expect(output).toContain("[SyncResume]");
  });

  it("6. crash after ENQUEUE_AI (rehydrates incidents & finishes projections)", () => {
    const { parsed, output } = runCrossProcessTest("ENQUEUE_AI");
    expect(parsed.ok).toBe(true);
    expect(output).toContain("[SyncResume]");
  });

  it("7. crash after REFRESHING_PROJECTIONS (finalizes sync_run)", () => {
    const { parsed, output } = runCrossProcessTest("REFRESHING_PROJECTIONS");
    expect(parsed.ok).toBe(true);
    expect(output).toContain("[SyncResume]");
  });

  it("8. PARITY TEST — compare uninterrupted sync vs crash + restart sync", () => {
    const uninterrupted = runCrossProcessTest("CREATED");
    const crashRestart = runCrossProcessTest("FETCHING_SNAPSHOT");

    expect(uninterrupted.parsed.ok).toBe(true);
    expect(crashRestart.parsed.ok).toBe(true);
    expect(uninterrupted.parsed.incidentCount).toBe(crashRestart.parsed.incidentCount);
    expect(uninterrupted.parsed.incidentCount).toBe(354);
  });
});
