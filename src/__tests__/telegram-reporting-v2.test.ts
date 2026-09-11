import { describe, expect, it } from "vitest";
import { classifyIncidentChange, emptyChangeCounts, formatIncidentStatusUpdate, formatSyncHeartbeat } from "@/integrations/telegram/incident-status-message";
import { formatFollowupDeliverySummary } from "@/integrations/telegram/followup-delivery-summary";

describe("Telegram reporting V2", () => {
  it("1-7 classifies every history category", () => {
    expect(classifyIncidentChange(null, 3, false)).toBe("NEW"); expect(classifyIncidentChange(2, 3, false)).toBe("INCREASED"); expect(classifyIncidentChange(3, 2, false)).toBe("DECREASED"); expect(classifyIncidentChange(2, 2, false)).toBe("UNCHANGED"); expect(classifyIncidentChange(2, 0, true)).toBe("RESOLVED"); expect(classifyIncidentChange(0, 2, false, true)).toBe("REOPENED"); expect(classifyIncidentChange(2, null, false)).toBe("UNKNOWN");
  });
  it("8-11 labels first, second, escalation, and mixed actions", () => {
    const text = formatFollowupDeliverySummary([{ province: "Yên Bái", warehouse: "A", stage: "FIRST", coveredCases: 1, status: "SUCCESS" }, { province: "Sơn La", warehouse: "B", stage: "SECOND", coveredCases: 1, status: "SUCCESS" }, { province: "Lào Cai", warehouse: "C", stage: "ESCALATION", coveredCases: 1, status: "FAILED" }]);
    expect(text).toContain("NHẮC LẦN 1"); expect(text).toContain("NHẮC LẦN 2"); expect(text).toContain("ESCALATE"); expect(text).toContain("Tổng action đã tạo: <b>3 case / 3 batch</b>");
  });
  it("12 reports zero actions factually", () => expect(formatFollowupDeliverySummary([])).toContain("Không tạo action tại checkpoint này"));
  it("13 reconciles dispatch success and failure", () => expect(formatFollowupDeliverySummary([{ province: "A", warehouse: "A", stage: "FIRST", coveredCases: 1, status: "SUCCESS" }, { province: "B", warehouse: "B", stage: "SECOND", coveredCases: 1, status: "FAILED" }])).toContain("Kết quả gửi (batch): ✅ 1 · ❌ 1"));
  it("14 labels scope", () => expect(formatSyncHeartbeat({ completedAt: "2026-09-11T04:00:00Z", active: 1, changed: 0, unchanged: 1, resolved: 0, failed: 0, scope: "Sơn La" })).toContain("Phạm vi: <b>Sơn La</b>"));
  it("15 labels completed as checkpoint delta", () => expect(formatSyncHeartbeat({ completedAt: "2026-09-11T04:00:00Z", active: 1, changed: 0, unchanged: 0, resolved: 1, failed: 0 })).toContain("Vừa hoàn thành từ checkpoint trước"));
  it("16 never claims WAIT", () => expect(formatSyncHeartbeat({ completedAt: "2026-09-11T04:00:00Z", active: 1, changed: 0, unchanged: 1, resolved: 0, failed: 0 })).not.toMatch(/WAIT|chưa cần/i));
  it("17 reconciles directional totals", () => { const categories = { ...emptyChangeCounts(), NEW: 1, INCREASED: 2, DECREASED: 1, UNCHANGED: 3, RESOLVED: 1, REOPENED: 1, UNKNOWN: 1 }; expect(formatSyncHeartbeat({ completedAt: "2026-09-11T04:00:00Z", active: 8, changed: 0, unchanged: 0, resolved: 0, failed: 0, categories })).toContain("Tổng case đã báo trạng thái: <b>10</b>"); });
  it("18 formats directional province detail", () => expect(formatIncidentStatusUpdate([{ warehouse: "Sơn La", reason: "Kho tồn", previousCount: 1, currentCount: 3, resolved: false }, { warehouse: "Mai Sơn", reason: "Kho tồn", previousCount: 4, currentCount: 2, resolved: false }], "2026-09-11T04:00:00Z", "Sơn La")).toMatch(/Tồn tăng[\s\S]*Tồn giảm/));
  it("19 has no operational side effect", () => expect(formatFollowupDeliverySummary.toString()).not.toMatch(/sendToChat|insert|update/));
  it("20 keeps V1 engine untouched", () => expect(classifyIncidentChange.toString()).not.toMatch(/evaluateNextState|PUSH_REQUESTED/));
});
