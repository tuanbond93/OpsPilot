import { describe, expect, it } from "vitest";
import { repairOperationalText } from "@/app/_components/operationalText";

describe("repairOperationalText", () => {
  it("repairs legacy Vietnamese UTF-8 mojibake", () => {
    expect(repairOperationalText("Sá»± cá»‘ Kho tá»“n")).toBe("Sự cố Kho tồn");
  });

  it("repairs a broken segment while preserving valid Vietnamese", () => {
    expect(repairOperationalText("Kho Việt Trì: ghi nháº­n 51 Ä‘Æ¡n hÃ ng")).toBe("Kho Việt Trì: ghi nhận 51 đơn hàng");
  });

  it("repairs legacy Planner recommendation titles", () => {
    expect(repairOperationalText("Theo dÃµi sÃ¡t diá»…n biáº¿n tá»“n kho")).toBe("Theo dõi sát diễn biến tồn kho");
  });

  it("does not alter correctly encoded Vietnamese", () => {
    expect(repairOperationalText("Khuyến nghị kiểm tra trạng thái giao hàng")).toBe("Khuyến nghị kiểm tra trạng thái giao hàng");
  });

  it("translates embedded fallback explanations and removes encoded spaces", () => {
    expect(repairOperationalText("Đánh giá vận hành. (Dynamic explanation unavailable)&#x20;"))
      .toBe("Đánh giá vận hành. (Chưa có giải thích từ AI) ");
  });
});
