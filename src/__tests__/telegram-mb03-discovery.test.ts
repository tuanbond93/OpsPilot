import { describe, expect, it } from "vitest";
import {
  advanceMb03Discovery,
  createMb03DiscoveryState,
  formatDiscoveryOrderEvidence,
  orderCodeCopyKeyboard,
  discoveryQuickReplyKeyboard,
  outcomeTimeGate,
  parseMb03QuickReplyCallback,
  resolveMb03ProvinceWarehouseIds,
  parseMb03CancelCommand,
  parseMb03StatusCommand,
  parseMb03GateCommand,
  parseMb03ClassCommand,
  parseMb03ClassifyCommand,
  parseMb03RemediateCommand,
  parseMb03AmendCommand,
  parseMb03ClassCallback,
  mb03ClassKeyboard,
  mb03PlaybookPrecheck,
  parseMb03OutcomeCommand,
  parseMb03StartCommand,
  validateDiscoveryReply,
} from "@/services/telegram-mb03-discovery";

describe("MB03 Telegram discovery", () => {
  it("accepts only explicit MB03 commands and requires a warehouse", () => {
    expect(parseMb03StartCommand("/mb03 Kho GHN Yên Bái")).toEqual({ warehouseName: "Kho GHN Yên Bái" });
    expect(parseMb03StartCommand("/mb03")).toEqual({ warehouseName: null });
    expect(parseMb03StartCommand("/discover Kho A")).toBeNull();
    expect(parseMb03CancelCommand("/mb03cancel")).toBe(true);
    expect(parseMb03StatusCommand("/mb03status")).toBe(true);
    expect(parseMb03StatusCommand("/mb03status extra")).toBe(false);
    expect(parseMb03GateCommand("/mb03gate")).toBe(true);
    expect(parseMb03ClassCommand("/mb03class MB03-20260830-0900 SLA_VS_BACKLOG_PRIORITIZATION")).toEqual({ caseId: "MB03-20260830-0900", decisionClass: "SLA_VS_BACKLOG_PRIORITIZATION" });
    expect(parseMb03ClassifyCommand("/mb03classify")).toBe(true);
    expect(parseMb03RemediateCommand("/mb03remediate")).toBe(true);
    expect(parseMb03AmendCommand("/mb03amend MB03-20260830-0900 RULE_CHECK NO thiếu capacity xác nhận")).toEqual({ caseId: "MB03-20260830-0900", field: "RULE_CHECK", value: "NO", reason: "thiếu capacity xác nhận" });
    expect(parseMb03AmendCommand("/mb03amend MB03-20260830-0900 RULE_CHECK YES không hợp lệ")).toBeNull();
    expect(parseMb03ClassCallback("mb03:c:MB03-20260830-0900:S")).toEqual({ caseId: "MB03-20260830-0900", decisionClass: "SLA_VS_BACKLOG_PRIORITIZATION" });
    expect(mb03ClassKeyboard("MB03-20260830-0900")).toHaveLength(3);
  });

  it("parses a bounded, evidence-bearing outcome command", () => {
    expect(parseMb03OutcomeCommand("/mb03outcome MB03-20260830-0900 SUCCESS còn 2 đơn lúc 13:00")).toEqual({
      caseId: "MB03-20260830-0900",
      classification: "SUCCESS",
      evidence: "còn 2 đơn lúc 13:00",
    });
    expect(parseMb03OutcomeCommand("/mb03outcome MB03-20260830-0900 SUCCESS")).toBeNull();
  });

  it("validates structured answers instead of guessing", () => {
    expect(validateDiscoveryReply("WINDOW_HOURS", "4")).toEqual({ ok: true, value: "4" });
    expect(validateDiscoveryReply("WINDOW_HOURS", "0").ok).toBe(false);
    expect(validateDiscoveryReply("AUTHORITY", "có quyền").ok).toBe(false);
    expect(validateDiscoveryReply("AUTHORITY", "YES - manager MB03").ok).toBe(true);
    expect(validateDiscoveryReply("MANAGER_THINKING", "LOW").ok).toBe(true);
  });

  it("provides safe quick replies only for closed questions", () => {
    expect(parseMb03QuickReplyCallback("mb03:q:WINDOW_HOURS:4")).toEqual({ step: "WINDOW_HOURS", value: "4" });
    expect(parseMb03QuickReplyCallback("mb03:q:OPTION_A:A")).toBeNull();
    expect(discoveryQuickReplyKeyboard("AUTHORITY")).toHaveLength(1);
    expect(discoveryQuickReplyKeyboard("OPTION_A")).toEqual([]);
  });

  it("blocks outcome until the declared measurement window has elapsed", () => {
    expect(outcomeTimeGate("2026-08-30T06:00:00.000Z", new Date("2026-08-30T05:30:00.000Z"))).toContain("13:00 30/08/2026");
    expect(outcomeTimeGate("2026-08-30T06:00:00.000Z", new Date("2026-08-30T06:00:00.000Z"))).toBeNull();
  });

  it("resolves a province topic to only its MB03 warehouse ids", () => {
    const yenBai = resolveMb03ProvinceWarehouseIds("Yên Bái");
    expect(yenBai).toContain("21161000");
    expect(yenBai).not.toContain("21321001");
  });

  it("shows unique operational order codes and never invents a fallback code", () => {
    expect(formatDiscoveryOrderEvidence([{
      reasonName: "Kho tồn",
      affectedOrderCount: 12,
      maximumAgeHours: 31.4,
      orderCodes: ["GY8ABC", "GY8ABC", "GY8XYZ"],
    }])).toContain("- GY8ABC\n- GY8XYZ");
    expect(formatDiscoveryOrderEvidence([])).toContain("chưa có mã mẫu trong snapshot hiện tại");
    expect(orderCodeCopyKeyboard(["GY1", "GY2", "GY3", "GY1"])).toEqual([
      [{ text: "Copy GY1", copyText: "GY1" }, { text: "Copy GY2", copyText: "GY2" }],
      [{ text: "Copy GY3", copyText: "GY3" }],
    ]);
  });

  it("explains the evidence needed before a manager calls a signal covered", () => {
    expect(mb03PlaybookPrecheck("KHO_CHUA_LUAN_CHUYEN", "Kho A")).toContain("kho kế tiếp");
    expect(mb03PlaybookPrecheck("KHO_TON", "Kho GHN A")).toContain("GHN_MISSED_0700_COT");
    expect(mb03PlaybookPrecheck("THIEU_SHIPPER", "Kho A")).toContain("PLAYBOOK_GAP");
  });

  it("finishes as discovery evidence without approving or executing anything", () => {
    let state = createMb03DiscoveryState({ warehouseName: "Kho MB03", chatId: "-1001", messageThreadId: 10, now: new Date("2026-08-30T02:00:00Z") });
    const replies = [
      "OUTSIDE",
      "Timeline hợp lệ nhưng không khớp bất kỳ rule nào trong playbook hiện tại",
      "09:00 có 35 đơn SLA và 80 đơn tồn >24h từ snapshot vận hành",
      "6 nhân sự và 2 xe đã xác nhận",
      "Ưu tiên 80 đơn tồn",
      "Ưu tiên 35 đơn SLA",
      "Giảm tồn hoặc bảo vệ SLA",
      "NO - rule không biết capacity thực tế",
      "NONE",
      "YES - manager MB03",
      "Giao ca vận hành ưu tiên nhóm SLA",
      "35 đơn SLA chưa xuất lúc 09:00",
      "SUCCESS nếu còn <=2; FAILURE nếu >10; guardrail tồn <=95",
      "4",
      "LOW",
    ];
    let last: ReturnType<typeof advanceMb03Discovery> | undefined;
    for (const reply of replies) {
      last = advanceMb03Discovery(state, reply, new Date("2026-08-30T02:00:00Z"));
      expect("error" in last).toBe(false);
      if (!("error" in last)) state = last.state;
    }
    expect(state.status).toBe("AWAITING_OUTCOME");
    expect(state.step).toBeNull();
    expect(state.outcomeDueAt).toBe("2026-08-30T06:00:00.000Z");
    expect(!("decisionStatus" in state)).toBe(true);
    expect(!("workOrder" in state)).toBe(true);
    expect(last && !("error" in last) ? last.prompt : "").toContain("CANDIDATE_REVIEW_REQUIRED");
    expect(last && !("error" in last) ? last.prompt : "").toContain("Không approval, không work order");
  });

  it("keeps covered playbook cases in the routine triage lane", () => {
    let state = createMb03DiscoveryState({ warehouseName: "Kho MB03", chatId: "-1001", messageThreadId: 10, now: new Date("2026-08-30T02:00:00Z") });
    for (const reply of ["COVERED", "Kiểm tra kho GHN vì sao chưa xuất sau COT", "4"]) {
      const advanced = advanceMb03Discovery(state, reply, new Date("2026-08-30T02:00:00Z"));
      expect("error" in advanced).toBe(false);
      if (!("error" in advanced)) state = advanced.state;
    }
    expect(state.status).toBe("AWAITING_OUTCOME");
    expect(state.lane).toBe("ROUTINE_TRIAGE");
  });
});
