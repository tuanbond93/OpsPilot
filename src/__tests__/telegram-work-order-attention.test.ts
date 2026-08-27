import { describe, expect, it } from "vitest";
import { deriveAttentionReasons } from "@/domain/telegram-work-order-attention";

describe("deriveAttentionReasons", () => {
  const now = new Date("2026-08-27T08:00:00.000Z");
  it("prioritizes unacknowledged support and overdue work", () => {
    expect(deriveAttentionReasons({ status: "IN_PROGRESS", dueAt: "2026-08-27T07:59:00.000Z", signals: ["NEEDS_SUPPORT"], now })).toEqual(["UNACKNOWLEDGED", "NEEDS_SUPPORT", "OVERDUE"]);
  });
  it("removes completed work from attention", () => {
    expect(deriveAttentionReasons({ status: "COMPLETED", dueAt: "2026-08-27T07:00:00.000Z", signals: [], now })).toEqual([]);
  });
  it("flags a due-soon work order but not acknowledged work", () => {
    expect(deriveAttentionReasons({ status: "OPEN", dueAt: "2026-08-27T09:30:00.000Z", signals: ["ACKNOWLEDGED"], now })).toEqual(["DUE_SOON"]);
  });
});
