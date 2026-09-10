import { describe, expect, it } from "vitest";
import { followupInlineKeyboard, parseFollowupCallbackData } from "@/integrations/telegram/followup-actions";
import {
  formatOtherPrompt,
  formatRecordedResponse,
  formatTeamLeadActionMessage,
  governedWarehouseContext,
  isTeamLeadActionReason,
} from "@/integrations/telegram/team-lead-action";
import { readFileSync } from "node:fs";

const reminderId = "f2f62f64-2748-4fcb-a51d-26df6be6a22f";

describe("Team Lead Telegram action contracts", () => {
  it("limits Team Lead pilot interactions to approved button contracts", () => {
    expect(isTeamLeadActionReason("KHO_TON")).toBe(true);
    expect(isTeamLeadActionReason("KHO_CHU_A_LUAN_CHUYEN")).toBe(true);
    expect(isTeamLeadActionReason("THIEU_SHIPPER")).toBe(false);

    const dispatcher = readFileSync("src/services/telegram-followup-pilot.ts", "utf8");
    const scopeGate = dispatcher.indexOf("if (!isTeamLeadActionReason(incident.reason_code))");
    const interactionInsert = dispatcher.indexOf('client.from("telegram_followup_reminders").insert(payload)');
    expect(scopeGate).toBeGreaterThan(-1);
    expect(scopeGate).toBeLessThan(interactionInsert);
  });

  it("renders Contract A with exact delivery labels", () => {
    const context = governedWarehouseContext("21712000", "Kho Giao Hàng Nặng - Tân Bình - HCM");
    expect(context.warehouseClass).toBe("DELIVERY");
    expect(followupInlineKeyboard(reminderId, true, "KHO_TON", context.warehouseClass).flat().map((button) => button.text)).toEqual([
      "Đã xuất/gán giao", "Đang chờ xuất/gán giao", "Chưa tới COT luân chuyển", "Khác",
    ]);
    expect(formatTeamLeadActionMessage({ stage: "FIRST", province: "Hồ Chí Minh", warehouseName: "Kho Giao Hàng Nặng - Tân Bình - HCM", warehouseClass: "DELIVERY", reasonCode: "KHO_TON", orderCodes: ["ORD-001"] })).toBe([
      "🔴 OPSPILOT — VIỆC CẦN XỬ LÝ", "", "📍 Hồ Chí Minh", "🏭 Kho Giao Hàng Nặng - Tân Bình - HCM", "📦 Đơn: ORD-001", "", "Vấn đề:", "Đơn đang được ghi nhận tồn tại bưu cục/kho giao.", "", "👉 CẦN KIỂM TRA:", "Tình trạng xử lý hiện tại của đơn là gì?",
    ].join("\n"));
  });

  it("renders Contract B with the full transit label", () => {
    expect(governedWarehouseContext("1626", "Kho Trung Chuyển Hồ Chí Minh 01").warehouseClass).toBe("TRANSIT");
    const buttons = followupInlineKeyboard(reminderId, true, "KHO_TON", "TRANSIT").flat();
    expect(buttons.map((button) => button.text)).toEqual([
      "Chưa đến COT luân chuyển", "Kho luân chuyển sót", "Đã luân chuyển nhưng bưu cục/kho giao chưa nhận hàng", "Khác",
    ]);
    expect(Buffer.byteLength(buttons[2].callbackData, "utf8")).toBeLessThanOrEqual(64);
  });

  it("renders Contract C with exact labels", () => {
    const buttons = followupInlineKeyboard(reminderId, true, "KHO_CHU_A_LUAN_CHUYEN", "TRANSIT").flat();
    expect(buttons.map((button) => button.text)).toEqual(["Đang luân chuyển", "Chưa đến COT luân chuyển", "Kho làm mất hàng", "Khác"]);
    expect(parseFollowupCallbackData(buttons[0].callbackData)?.signal).toBe("IN_TRANSIT");
  });

  it("does not guess a KHO_TON contract for unknown governed type", () => {
    expect(followupInlineKeyboard(reminderId, true, "KHO_TON", "UNKNOWN").flat().map((button) => button.text)).toEqual(["Đã nhận việc", "Cần hỗ trợ", "Đã cập nhật tiến độ"]);
  });

  it("keeps the canonical target for Khác and confirmation", () => {
    expect(formatOtherPrompt(["ORD-001"])).toBe("Vui lòng mô tả ngắn tình trạng thực tế của đơn ORD-001.");
    const confirmation = formatRecordedResponse(["ORD-001"], "Đã xuất/gán giao");
    expect(confirmation).toContain("📦 ORD-001");
    expect(confirmation).toContain("Kết quả: Đã xuất/gán giao");
    expect(confirmation).not.toMatch(/FOLLOWING_UP|delivery_fail|incident UUID|GHN_EVIDENCE_UNAVAILABLE/);
  });

  it("renders a later follow-up as a new interaction with previous answer", () => {
    const message = formatTeamLeadActionMessage({ stage: "SECOND", province: "Phú Thọ", warehouseName: "Kho Chuyển Tiếp Phú Thọ", warehouseClass: "TRANSIT", reasonCode: "KHO_TON", orderCodes: ["ORD-002"], previousResponseLabel: "Chưa đến COT luân chuyển" });
    expect(message).toContain("🔔 OPSPILOT — CẦN KIỂM TRA LẠI");
    expect(message).toContain("Lần trước đã phản hồi:\nChưa đến COT luân chuyển");
    expect(message).toContain("Tại sao đơn vẫn còn tại kho?");
  });
});
