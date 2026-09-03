import { describe, expect, it } from "vitest";
import { formatFollowupDeliverySummary } from "@/integrations/telegram/followup-delivery-summary";

describe("Telegram follow-up delivery summary", () => {
  it("combines all provincial delivery results into one manager report", () => {
    const text = formatFollowupDeliverySummary([
      { province: "Hòa Bình", warehouse: "Kho A", stage: "FIRST", coveredCases: 2, status: "SUCCESS" },
      { province: "Hòa Bình", warehouse: "Kho B", stage: "FIRST", coveredCases: 1, status: "FAILED", error: "timeout" },
      { province: "Sơn La", warehouse: "Kho C", stage: "SECOND", coveredCases: 3, status: "SUCCESS" },
    ], new Date("2026-09-02T01:00:00Z"));
    expect(text).toContain("Tổng follow-up: <b>3 batch / 6 case</b>");
    expect(text).toContain("Hòa Bình: 2 batch / 3 case · ✅ 1 · ❌ 1");
    expect(text).toContain("Sơn La: 1 batch / 3 case · ✅ 1 · ❌ 0");
    expect(text).toContain("Kho B · FIRST: timeout");
  });

  it("separates a Lao Cai Rillnet review from a Yen Bai follow-up", () => {
    const text = formatFollowupDeliverySummary([
      { province: "Yên Bái", warehouse: "Kho Giao Hàng Nặng Yên Bái", stage: "SECOND", coveredCases: 1, status: "SUCCESS" },
    ], new Date("2026-09-02T04:56:52Z"), [
      { province: "Lào Cai", warehouse: "Kho Giao Hàng Nặng - TP Lào Cai", affectedOrders: 5, status: "SUCCESS" },
    ]);

    expect(text).toContain("1. RILLNET REVIEW MỚI");
    expect(text).toContain("✅ Lào Cai · Kho Giao Hàng Nặng - TP Lào Cai: 1 case · 5 đơn ảnh hưởng");
    expect(text).toContain("2. FOLLOW-UP ĐÃ GỬI");
    expect(text).toContain("không bao gồm Rillnet review ở mục 1");
    expect(text).toContain("Yên Bái: 1 batch / 1 case");
  });
});
