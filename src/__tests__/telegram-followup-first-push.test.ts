import { describe, expect, it } from "vitest";
import { formatTelegramFollowupFirstPush, formatTelegramFollowupReminder } from "@/integrations/telegram/followup-first-push";

describe("Telegram first-push reminder", () => {
  it("uses a short actionable structure with one order per line", () => {
    const message = formatTelegramFollowupFirstPush({ incidentKey: "INC-01", warehouseName: "Kho A", reasonName: "Tồn kho", affectedOrderCount: 2, maximumAgeHours: 24.5, orderCodes: ["A1", "A2", "A1"] }, [{ displayName: "Nhân viên", username: "operator" }]);
    expect(message).toContain("NHẮC LẦN 1");
    expect(message).toContain("Sự cố: Tồn kho");
    expect(message).toContain("Kho phụ trách: Kho A");
    expect(message).toContain("Mã đơn cần kiểm tra:");
    expect(message).toContain('<a href="https://tracuunoibo.ghn.vn/internal?order_code=A1">A1</a>');
    expect(message).toContain('<a href="https://tracuunoibo.ghn.vn/internal?order_code=A2">A2</a>');
    expect(message).toContain("Reply theo từng dòng:");
    expect(message).toContain("MÃ_ĐƠN: nguyên nhân / hướng xử lý");
    expect(message).not.toContain("Mã follow-up");
    expect(message).not.toContain("Người nhận:");
  });

  it("keeps Manager escalation separate from the three reminder stages", () => {
    const message = formatTelegramFollowupReminder("ESCALATION", { incidentKey: "INC-02", warehouseName: "Kho B", reasonName: "Tồn kho", affectedOrderCount: 4, orderCodes: ["B1"] }, [{ displayName: "Manager" }]);
    expect(message).toContain("CẦN MANAGER CAN THIỆP");
    expect(message).toContain("sau 3 lần nhắc");
    expect(message).toContain("B1");
  });

  it("escapes dynamic text before Telegram renders it as HTML", () => {
    const message = formatTelegramFollowupFirstPush({ incidentKey: "INC-03", warehouseName: "Kho A & B", reasonName: "Tồn <chưa rõ>", affectedOrderCount: 1, orderCodes: ["A&1"] }, []);
    expect(message).toContain("Kho A &amp; B");
    expect(message).toContain("Tồn &lt;chưa rõ&gt;");
    expect(message).toContain("order_code=A%261");
  });

  it("asks eligible outbound cases to use quick responses and reserves text for Khác", () => {
    const message = formatTelegramFollowupFirstPush({ incidentKey: "INC-04", warehouseName: "Kho A", reasonName: "Kho tồn", affectedOrderCount: 1, orderCodes: ["A1"], structuredOutboundResponses: true }, []);
    expect(message).toContain("Chọn một phản hồi bên dưới");
    expect(message).toContain("Chỉ Reply nếu chọn Khác");
    expect(message).toContain("không cần nhập lại mã đơn");
    expect(message).not.toContain("MÃ_ĐƠN: nguyên nhân / hướng xử lý");
  });
});
