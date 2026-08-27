import { describe, expect, it } from "vitest";
import { workOrderEvidence } from "@/integrations/telegram/work-order-evidence";

describe("workOrderEvidence", () => {
  it("keeps the Telegram scope to the selected owner and action", () => {
    const decision: any = { evidence: { operationalFacts: { sampleOrderCodes: ["FALLBACK"], groups: [
      { title: "Kho A chưa xuất", warehouseName: "Kho A", action: "Kiểm tra xuất", orderCodes: ["A-1", "A-2"], orderCount: 2 },
      { title: "Kho B chậm", warehouseName: "Kho B", action: "Kiểm tra kho B", orderCodes: ["B-1"], orderCount: 1 },
    ] } } };
    const workOrder: any = { owner: "Kho A", actionItems: ["Kiểm tra xuất"] };
    expect(workOrderEvidence(decision, workOrder)).toEqual({ orderCodes: ["A-1", "A-2"], groupTitles: ["Kho A chưa xuất"], affectedOrderCount: 2 });
  });
});
