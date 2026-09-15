import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MAX_PHASE2_CHECKPOINT_ATTEMPTS, phase2FailureOutcome } from "@/services/phase2-checkpoint-work";

describe("Phase2 checkpoint work contract", () => {
  it("keeps retry bounded at the governed maximum", () => {
    expect(MAX_PHASE2_CHECKPOINT_ATTEMPTS).toBe(3);
  });

  it("retries only transient infrastructure failures", () => {
    expect(phase2FailureOutcome(new Error("Gateway Timeout"))).toBe("RETRYABLE");
    expect(phase2FailureOutcome(new Error("Unauthorized"))).toBe("FAILED");
  });

  it("uses checkpoint identity as the work identity", () => {
    const migration = readFileSync("src/database/migrations/072_phase2_checkpoint_dispatch.sql", "utf8");
    expect(migration).toContain("checkpoint_at TIMESTAMPTZ PRIMARY KEY");
    expect(migration).toContain("FOR UPDATE SKIP LOCKED");
    expect(migration).toContain("opspilot-phase2-checkpoint-dispatch");
    expect(migration).not.toContain("opspilot-followup-cycle-mb3");
  });

  it("keeps the dispatcher method aligned with the endpoint handler", () => {
    const migration = readFileSync("src/database/migrations/073_phase2_checkpoint_dispatch_get.sql", "utf8");
    const endpoint = readFileSync("src/app/api/cron/phase2-checkpoint/route.ts", "utf8");
    expect(migration).toContain("net.http_get(");
    expect(migration).not.toContain("net.http_post(");
    expect(endpoint).toContain("export async function GET");
    expect(migration).toContain("Authorization','Bearer ' || cron_secret");
    expect(migration).toContain("x-opspilot-phase2-token");
  });
});
