import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("Level C follow-up Decision bridge migration", () => {
  const sql = fs.readFileSync("src/database/migrations/052_level_c_followup_decision_bridge.sql", "utf8");

  it("links both employee reminders and Manager Rillnet reviews to a Decision", () => {
    expect(sql).toMatch(/ALTER TABLE telegram_followup_reminders[\s\S]*decision_id UUID NULL REFERENCES decisions\(id\)/);
    expect(sql).toMatch(/ALTER TABLE telegram_rillnet_review_requests[\s\S]*decision_id UUID NULL REFERENCES decisions\(id\)/);
    expect(sql).toContain("FOLLOWUP_DECISION_LINK_MISMATCH");
  });

  it("records reply and review evidence without changing Decision state", () => {
    expect(sql).toContain("TELEGRAM_FOLLOWUP_");
    expect(sql).toContain("TELEGRAM_RILLNET_MANAGER_REVIEWED");
    expect(sql).toContain("'transitionedDecision', false");
    expect(sql).not.toMatch(/UPDATE decisions SET decision_status/);
  });

  it("backfills both sides regardless of whether the reminder or Decision came first", () => {
    expect(sql).toContain("backfill_followup_evidence_for_decision");
    expect(sql).toContain("UPDATE telegram_followup_reminders r");
    expect(sql).toContain("UPDATE telegram_rillnet_review_requests r");
    expect(sql).toContain("'backfilled', true");
  });
});
