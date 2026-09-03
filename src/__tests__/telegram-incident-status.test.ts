import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { formatIncidentStatusUpdate, formatSyncHeartbeat } from "@/integrations/telegram/incident-status-message";

describe("Telegram per-sync incident status", () => {
  it("distinguishes changed, unchanged and completed incidents", () => {
    const message = formatIncidentStatusUpdate([
      { warehouse: "Kho A", reason: "Kho tồn", previousCount: 2, currentCount: 3, resolved: false },
      { warehouse: "Kho B", reason: "Kho tồn", previousCount: 1, currentCount: 1, resolved: false },
      { warehouse: "Kho C", reason: "Kho tồn", previousCount: 1, currentCount: 0, resolved: true },
    ], "2026-09-02T09:01:39.416Z");
    expect(message).toContain("Có thay đổi");
    expect(message).toContain("Không thay đổi");
    expect(message).toContain("Sự cố đã hoàn thành");
  });

  it("always renders a Manager heartbeat, including a zero-change cycle", () => {
    expect(formatSyncHeartbeat({ completedAt: "2026-09-02T09:01:39.416Z", active: 18, changed: 0, unchanged: 18, resolved: 0, failed: 0 })).toContain("SYNC OPSPILOT ĐÃ HOÀN TẤT");
  });

  it("persists idempotency per case/sync and only one terminal notice", () => {
    const sql = fs.readFileSync("src/database/migrations/053_telegram_incident_sync_status.sql", "utf8");
    expect(sql).toContain("UNIQUE(followup_case_id, sync_run_id)");
    expect(sql).toContain("telegram_incident_one_resolved_notice");
    expect(sql).toContain("sync_run_id UUID NOT NULL UNIQUE");
  });
});
