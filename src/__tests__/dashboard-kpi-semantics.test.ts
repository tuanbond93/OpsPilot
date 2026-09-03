import { describe, expect, it } from "vitest";
import { summarizeNotificationActions } from "@/projections/notification-projection";
import { getVietnamDayWindow, isTimestampInWindow } from "@/services/impl/DashboardService";

describe("Dashboard KPI semantics", () => {
  it("treats a cancelled queue action with DELIVERED outcome as sent, not failed", () => {
    expect(summarizeNotificationActions([
      { status: "CANCELLED", outcome: "DELIVERED" },
      { status: "FAILED", outcome: "FAILED" },
      { status: "CANCELLED", outcome: null },
    ])).toEqual({ pending: 0, sent: 1, failed: 1, retry: 0 });
  });

  it("uses the Vietnam calendar day instead of the UTC calendar day", () => {
    const now = Date.parse("2026-09-02T01:00:00.000Z"); // 08:00 in Vietnam
    const window = getVietnamDayWindow(now);

    expect(window.startIso).toBe("2026-09-01T17:00:00.000Z");
    expect(isTimestampInWindow("2026-09-01T16:59:59.999Z", window.startMs, window.endMs)).toBe(false);
    expect(isTimestampInWindow("2026-09-01T17:00:00.000Z", window.startMs, window.endMs)).toBe(true);
    expect(isTimestampInWindow("2026-09-02T16:59:59.999Z", window.startMs, window.endMs)).toBe(true);
    expect(isTimestampInWindow("2026-09-02T17:00:00.000Z", window.startMs, window.endMs)).toBe(false);
  });
});
