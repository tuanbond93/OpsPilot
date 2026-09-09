import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALREADY_RESPONDED_USER_MESSAGE } from "@/integrations/telegram/team-lead-action";

const migration = fs.readFileSync(path.join(process.cwd(), "src/database/migrations/063_team_lead_telegram_interaction_lock.sql"), "utf8");
const webhook = fs.readFileSync(path.join(process.cwd(), "src/app/api/integrations/telegram/webhook/route.ts"), "utf8");

describe("Team Lead first-response-wins persistence", () => {
  it("serializes concurrent callbacks and rejects every later response", () => {
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("already_locked");
    expect(migration).toContain("RETURN 'ALREADY_RESPONDED'");
    expect(migration).toContain("RETURN 'ACCEPTED'");
    expect(migration).toContain("responded_at IS NOT NULL");
  });

  it("persists reason and workflow evidence in the same transaction", () => {
    expect(migration).toContain("response_code=p_response_code");
    expect(migration).toContain("INSERT INTO telegram_followup_reminder_events");
    expect(migration).toContain("'SIGNAL_RECEIVED'");
  });

  it("removes the keyboard and exposes no second workflow write path", () => {
    expect(webhook).toContain('method: "editMessageText"');
    expect(webhook).toContain("inline_keyboard: []");
    expect(webhook).toContain('claim !== "ACCEPTED"');
    expect(webhook).not.toContain("buildFollowupResponseEventRows(related");
  });

  it("maps the internal already-responded result to approved Vietnamese UX", () => {
    expect(ALREADY_RESPONDED_USER_MESSAGE).toBe("Phản hồi đã được ghi nhận trước đó và không thể thay đổi.");
    expect(webhook).toContain("claim === \"ALREADY_RESPONDED\" ? ALREADY_RESPONDED_USER_MESSAGE");
    expect(webhook).not.toContain('? "ALREADY_RESPONDED" :');
  });
});
