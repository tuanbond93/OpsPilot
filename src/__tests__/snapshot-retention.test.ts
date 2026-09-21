import { describe, expect, it } from "vitest";
import {
  classifyRawOrderDetail,
  isWithinOrderSnapshotRetention,
  ORDER_SNAPSHOT_RETENTION_DAYS,
} from "@/config/retention";

describe("raw order snapshot retention contract", () => {
  const now = new Date("2026-09-21T12:00:00.000Z");

  it("uses one canonical 21-day retention period", () => {
    expect(ORDER_SNAPSHOT_RETENTION_DAYS).toBe(21);
  });

  it("keeps recent raw detail available and distinguishes missing rows", () => {
    expect(isWithinOrderSnapshotRetention("2026-09-10T12:00:00.000Z", now)).toBe(true);
    expect(classifyRawOrderDetail("2026-09-10T12:00:00.000Z", true, now)).toBe("AVAILABLE");
    expect(classifyRawOrderDetail("2026-09-10T12:00:00.000Z", false, now)).toBe("NOT_FOUND");
  });

  it("marks expired raw detail explicitly instead of treating it as empty history", () => {
    expect(classifyRawOrderDetail("2026-08-30T12:00:00.000Z", false, now)).toBe("EXPIRED_BY_RETENTION");
  });
});
