import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_CHECKPOINT_RECOVERY_ATTEMPTS,
  isRetryableRecoveryHttpOutcome,
  nextRecoveryAttemptAt,
} from "@/services/checkpoint-recovery";

const migration = readFileSync(join(process.cwd(), "src/database/migrations/071_checkpoint_recovery_delivery_contract.sql"), "utf8");

describe("checkpoint recovery delivery contract", () => {
  it("accepts each retryable infrastructure response and rejects auth", () => {
    expect(isRetryableRecoveryHttpOutcome({ timedOut: true })).toBe(true);
    for (const statusCode of [500, 502, 503, 504]) {
      expect(isRetryableRecoveryHttpOutcome({ statusCode })).toBe(true);
    }
    expect(isRetryableRecoveryHttpOutcome({ statusCode: 401 })).toBe(false);
    expect(isRetryableRecoveryHttpOutcome({ statusCode: 403 })).toBe(false);
  });

  it("uses bounded, increasing retry backoff", () => {
    expect(MAX_CHECKPOINT_RECOVERY_ATTEMPTS).toBe(3);
    const now = Date.parse("2026-09-14T11:00:00.000Z");
    expect(nextRecoveryAttemptAt(1, now)).toBe("2026-09-14T11:05:00.000Z");
    expect(nextRecoveryAttemptAt(2, now)).toBe("2026-09-14T11:10:00.000Z");
  });

  it("claims only PENDING rows under a row lock and records the request id", () => {
    expect(migration).toContain("WHERE status = 'PENDING' AND coalesce(next_attempt_at, scheduled_for) <= now()");
    expect(migration).toContain("FOR UPDATE SKIP LOCKED");
    expect(migration).toContain("SET status = 'DISPATCHING', recovery_attempt = recovery.recovery_attempt + 1");
    expect(migration).toContain("last_request_id = request_id");
  });

  it("reconciles an effective checkpoint before retrying a timed-out request", () => {
    expect(migration).toContain("WHERE checkpoint_at = recovery.checkpoint_at");
    expect(migration).toContain("status = 'CONFIRMED', completed_at = now(), sync_run_id = existing_sync");
    expect(migration).toContain("A durable completed checkpoint is stronger evidence than a pg_net timeout");
  });

  it("does not strand timeout or 5xx in DISPATCHING and persists terminal visibility", () => {
    expect(migration).toContain("response.timed_out OR response.status_code >= 500");
    expect(migration).toContain("SET status = 'PENDING', next_attempt_at = retry_at, recovery_token = NULL");
    expect(migration).toContain("status = 'FAILED_REQUIRES_ATTENTION'");
    expect(migration).toContain("failure_stage = 'CHECKPOINT_FAILED_REQUIRES_ATTENTION'");
  });

  it("uses an explicit timeout above the measured checkpoint contract", () => {
    expect(migration).toContain("timeout_milliseconds := 330000");
  });
});
