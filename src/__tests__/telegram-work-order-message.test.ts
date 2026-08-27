import { describe, expect, it } from "vitest";
import { formatTelegramWorkOrderMessage } from "@/integrations/telegram/work-order-message";

describe("formatTelegramWorkOrderMessage", () => {
  it("renders the generated work order code, mapped recipient, and manual-reply boundary", () => {
    const message = formatTelegramWorkOrderMessage({ workOrderId: "wo-1", decisionId: "d-1", workOrderCode: "OPSP-WO-20260827-AAAA-01", status: "OPEN", owner: "Kho A", dueAt: "2026-08-27T05:00:00.000Z", actionItems: ["Đối soát log xuất kho"], createdBy: "manager", createdAt: "2026-08-27T01:00:00.000Z" }, [{ displayName: "Nguyễn A", username: "nguyena" }]);
    expect(message).toContain("OPSP-WO-20260827-AAAA-01");
    expect(message).toContain("@nguyena");
    expect(message).toContain("Đối soát log xuất kho");
    expect(message).toContain("Manager vẫn là người xác nhận trạng thái");
  });
});
