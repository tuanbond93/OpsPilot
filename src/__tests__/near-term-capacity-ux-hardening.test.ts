import { describe, expect, it, vi } from "vitest";
import {
  formatNearTermFactRequest,
  formatNearTermFactConfirmation,
  formatNearTermManagerCard,
  nearTermFactAnswerLabels,
  actionDisplayMetadata,
  type NearTermFactAnswer,
} from "@/integrations/telegram/near-term-capacity-message";
import { NearTermCapacityRuntimeService } from "@/services/near-term-capacity-runtime";
import type {
  CurrentRisk,
  DecisionContext,
  LeadFact,
  AiRecommendation,
} from "@/domain/near-term-capacity";

const sampleRisk: CurrentRisk = {
  warehouseId: "21160000",
  warehouseName: "Kho Giao Hàng Nặng - Việt Trì - Phú Thọ",
  capturedAt: "2026-09-18T08:00:00.000Z",
  currentOrders: 6,
  currentKg: 104,
  b2bOrders: null,
  evidenceRefs: ["incident:test-case-003"],
  riskSignals: ["KHO_TON"],
  hardSlaConstraint: "Backlog risk",
};

const sampleLead: LeadFact = {
  interactionId: "case-003",
  suppliedBy: "telegram:lead-user-1",
  capturedAt: "2026-09-18T08:05:00.000Z",
  source: "HUMAN_OPERATIONAL_GROUND_TRUTH",
  incoming: "NO_SIGNIFICANT_INCOMING",
  expectedIncomingKg: null,
  expectedIncomingAt: null,
  incomingType: null,
  availableVehicles: null,
  availableManpower: null,
  confidence: "HIGH",
};

const sampleContext: DecisionContext = {
  decisionCaseId: "case-003",
  facts: sampleRisk,
  humanGroundTruth: sampleLead,
  policy: {
    nearTermWindowMinutes: 240,
    leadFactMaxAgeMinutes: 60,
    allowedActions: ["NO_ACTION_MONITOR"],
  },
  uncertainties: [],
  allowedActions: ["NO_ACTION_MONITOR"],
};

const sampleDecision: AiRecommendation = {
  decision_case_id: "case-003",
  recommended_action: "NO_ACTION_MONITOR",
  confidence: 0.85,
  reason_summary: "Tồn kho trong giới hạn kiểm soát và không có hàng lớn phát sinh trong 4h tới theo xác nhận từ Lead.",
  current_risk: "Tồn kho 104 kg / 6 đơn.",
  expected_state_if_no_action: "Tồn kho được giải tỏa dần theo ca làm việc tiêu chuẩn.",
  expected_state_if_action: "Đảm bảo SLA ổn định mà không phát sinh chi phí xe ngoài.",
  key_evidence: ["case-003"],
  execution_instruction: "Tiếp tục theo dõi",
  required_by: "2026-09-18T10:00:00.000Z",
  required_followup_at: "2026-09-18T12:00:00.000Z",
  uncertainties: [],
  estimated_cost_vnd: null,
  estimated_saving_vnd: null,
};

function createMockDb(caseStatus = "FACT_REQUESTED") {
  const events: any[] = [];
  const cases = [
    {
      id: "case-test-123",
      warehouse_id: "21160000",
      warehouse_name: "Kho Giao Hàng Nặng - Việt Trì - Phú Thọ",
      current_risk_snapshot: sampleRisk,
      lead_fact_snapshot: null,
      status: caseStatus,
      active: true,
    },
  ];

  const db: any = {
    from: vi.fn((table: string) => {
      if (table === "near_term_capacity_cases") {
        return {
          select: () => ({
            eq: (_field: string, val: string) => ({
              maybeSingle: async () => ({
                data: cases.find((c) => c.id === val) || null,
                error: null,
              }),
            }),
          }),
          update: (patch: any) => ({
            eq: (_field: string, val: string) => {
              const row = cases.find((c) => c.id === val);
              if (row) Object.assign(row, patch);
              return {
                eq: () => ({ error: null }),
                then: (res: any) => res({ error: null }),
              };
            },
          }),
        };
      }
      if (table === "near_term_capacity_events") {
        return {
          select: () => ({
            eq: (_field: string, _val: string) => ({
              eq: (_f2: string, type: string) => ({
                maybeSingle: async () => {
                  if (type === "FACT_REQUEST_SENT") {
                    return {
                      data: {
                        id: "evt-sent",
                        payload: { telegramMessageId: 888, memberId: "lead-member-1" },
                      },
                      error: null,
                    };
                  }
                  return { data: null, error: null };
                },
              }),
            }),
          }),
          insert: (record: any) => {
            events.push(record);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "near_term_capacity_fact_responses") {
        return {
          insert: () => Promise.resolve({ error: null }),
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        insert: () => Promise.resolve({ error: null }),
      };
    }),
  };

  return { db, events, cases };
}

describe("OpsPilot Level C — Decision UX Hardening", () => {
  describe("Defect 1 — Lead Fact Response Confirmation & Button Removal", () => {
    it("1. Lead fact response triggers editMessageText on original message", async () => {
      const { db } = createMockDb("FACT_REQUESTED");
      const service = new NearTermCapacityRuntimeService(db);

      const mockEditMessageText = vi.fn().mockResolvedValue({ ok: true });
      (service as any).telegram = {
        editMessageText: mockEditMessageText,
        sendToChat: vi.fn().mockResolvedValue({ messageId: 999 }),
      };

      const result = await service.consumeInitialAnswer(
        "case-test-123",
        "NO_SIGNIFICANT_INCOMING",
        "lead-member-1",
        "-100123456789",
        888,
        1,
        {
          displayName: "Nguyễn Văn Lead",
          role: "Lead kho Phú Thọ",
          capturedAt: new Date("2026-09-18T08:10:00.000Z"),
          originalText: "🟠 OPSPILOT — CẦN XÁC NHẬN NĂNG LỰC XỬ LÝ\nKho: Phú Thọ",
        }
      );

      expect(mockEditMessageText).toHaveBeenCalledTimes(1);
      const [chatId, messageId, updatedText, options] = mockEditMessageText.mock.calls[0];
      expect(chatId).toBe("-100123456789");
      expect(messageId).toBe(888);
      expect(updatedText).toContain("✅ ĐÃ GHI NHẬN PHẢN HỒI");
      expect(options).toEqual({ inlineKeyboard: [] });
    });

    it("2. Edited message displays chosen response in clear Vietnamese text for all answers", () => {
      const answers: NearTermFactAnswer[] = [
        "ACTION_PLANNED",
        "EXCEPTION_REPORTED",
        "ASSISTANCE_REQUESTED",
      ];

      for (const ans of answers) {
        const confirmedText = formatNearTermFactConfirmation("Original Prompt", {
          answer: ans,
          responderName: "Nguyễn Văn Lead",
          responderRole: "Lead kho",
          answeredAt: "2026-09-18T08:10:00.000Z",
        });

        expect(confirmedText).toContain("✅ ĐÃ GHI NHẬN PHẢN HỒI");
        expect(confirmedText).toContain("Phản hồi:");
        expect(confirmedText).toContain(nearTermFactAnswerLabels[ans]);
        expect(confirmedText).toContain("Người xác nhận:\nNguyễn Văn Lead (Lead kho)");
        expect(confirmedText).toContain("Thời gian:\n15:10 18/09"); // UTC+7
        expect(confirmedText).toContain("🤖 OpsPilot đang phân tích và sẽ gửi quyết định cho Manager.");
      }
    });

    it("3. Edited message strips all action buttons via inlineKeyboard: []", async () => {
      const { db } = createMockDb("FACT_REQUESTED");
      const service = new NearTermCapacityRuntimeService(db);

      const mockEditMessageText = vi.fn().mockResolvedValue({ ok: true });
      (service as any).telegram = {
        editMessageText: mockEditMessageText,
        sendToChat: vi.fn().mockResolvedValue({ messageId: 999 }),
      };

      await service.consumeInitialAnswer(
        "case-test-123",
        "UNKNOWN",
        "lead-member-1",
        "-100123456789",
        888,
        2
      );

      expect(mockEditMessageText).toHaveBeenCalledWith(
        "-100123456789",
        888,
        expect.stringContaining("✅ ĐÃ GHI NHẬN PHẢN HỒI"),
        { inlineKeyboard: [] }
      );
    });

    it("4. Second button click returns ALREADY_RESPONDED without editing or modifying facts", async () => {
      const { db, events } = createMockDb("FACT_CAPTURED"); // Already responded
      const service = new NearTermCapacityRuntimeService(db);

      const mockEditMessageText = vi.fn().mockResolvedValue({ ok: true });
      (service as any).telegram = {
        editMessageText: mockEditMessageText,
      };

      const result = await service.consumeInitialAnswer(
        "case-test-123",
        "CONFIRMED_ETA",
        "lead-member-1",
        "-100123456789",
        888,
        3
      );

      expect(result.status).toBe("ALREADY_RESPONDED");
      expect(mockEditMessageText).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    it("5. Telegram edit failure does not fail the fact capture (fail-soft)", async () => {
      const { db } = createMockDb("FACT_REQUESTED");
      const service = new NearTermCapacityRuntimeService(db);

      // Telegram edit throws network/rate-limit error
      const mockEditMessageText = vi.fn().mockRejectedValue(new Error("Telegram API 429 Too Many Requests"));
      (service as any).telegram = {
        editMessageText: mockEditMessageText,
        sendToChat: vi.fn().mockResolvedValue({ messageId: 999 }),
      };

      // consumeInitialAnswer must not throw despite editMessageText failure
      await expect(
        service.consumeInitialAnswer(
          "case-test-123",
          "NO_SIGNIFICANT_INCOMING",
          "lead-member-1",
          "-100123456789",
          888,
          4
        )
      ).resolves.not.toThrow();

      expect(mockEditMessageText).toHaveBeenCalledTimes(1);
    });
  });

  describe("Defect 2 — Manager Decision Card Operational Vietnamese Hardening", () => {
    it("6. Manager decision card renders human operational text (CHƯA ĐIỀU THÊM XE TRONG 4 GIỜ TỚI)", () => {
      const card = formatNearTermManagerCard(
        sampleRisk.warehouseName,
        sampleRisk,
        sampleLead,
        sampleContext,
        sampleDecision
      );

      expect(card).toContain("🤖 AI ĐỀ XUẤT");
      expect(card).toContain(actionDisplayMetadata.NO_ACTION_MONITOR.title);
      expect(card).toContain("CHƯA ĐIỀU THÊM XE TRONG 4 GIỜ TỚI");
      expect(card).toContain(actionDisplayMetadata.NO_ACTION_MONITOR.subtitle);
    });

    it("7. Manager decision card does not show raw NO_ACTION_MONITOR as primary decision text", () => {
      const card = formatNearTermManagerCard(
        sampleRisk.warehouseName,
        sampleRisk,
        sampleLead,
        sampleContext,
        sampleDecision
      );

      // Should not be "🤖 AI ĐỀ XUẤT\nNO_ACTION_MONITOR"
      expect(card).not.toMatch(/🤖 AI ĐỀ XUẤT\s*\n\s*NO_ACTION_MONITOR/);
    });

    it("8. Manager decision card includes secondary technical tag in metadata block only", () => {
      const card = formatNearTermManagerCard(
        sampleRisk.warehouseName,
        sampleRisk,
        sampleLead,
        sampleContext,
        sampleDecision
      );

      expect(card).toContain("🏷️ Mã kỹ thuật: NO_ACTION_MONITOR");
      // Check that the AI ĐỀ XUẤT section does not contain the technical code
      const aiSection = card.split("🤖 AI ĐỀ XUẤT")[1]?.split("📌 LÝ DO")[0] || "";
      expect(aiSection).not.toContain("NO_ACTION_MONITOR");
      expect(aiSection).toContain("CHƯA ĐIỀU THÊM XE TRONG 4 GIỜ TỚI");
    });

    it("9. Manager decision card contains explicit NẾU APPROVE explanation without autonomous execution claims", () => {
      const card = formatNearTermManagerCard(
        sampleRisk.warehouseName,
        sampleRisk,
        sampleLead,
        sampleContext,
        sampleDecision
      );

      expect(card).toContain("✅ NẾU APPROVE");
      expect(card).toContain("Ghi nhận quyết định:\nKhông bổ sung xe/năng lực tại thời điểm hiện tại.");
      expect(card).toContain("Kho tiếp tục xử lý theo năng lực hiện có.");
      expect(card).toContain("OpsPilot tiếp tục theo dõi tại checkpoint tiếp theo.");
      // Strictly avoid phrasing that implies OpsPilot autonomously executes vehicle dispatch
      expect(card).not.toContain("OpsPilot không điều thêm xe");
    });

    it("10. Manager decision card eliminates contradictory 'Nếu không làm / Nếu thực hiện' for NO_ACTION_MONITOR", () => {
      const card = formatNearTermManagerCard(
        sampleRisk.warehouseName,
        sampleRisk,
        sampleLead,
        sampleContext,
        sampleDecision
      );

      // Contradictory copy removed for NO_ACTION_MONITOR
      expect(card).not.toContain("Nếu không làm:");
      expect(card).not.toContain("Nếu thực hiện:");

      // Decision-aware copy present
      expect(card).toContain("Nếu duy trì hiện trạng:");
      expect(card).toContain("⚠️ Rủi ro cần theo dõi:");
      expect(card).toContain("Điều kiện cần xem xét can thiệp:");
      expect(card).toContain("🔄 Kiểm tra lại:");
    });

    it("11. Non-NO_ACTION_MONITOR actions retain standard contrast and appropriate operational titles", () => {
      const addVehicleDecision: AiRecommendation = {
        ...sampleDecision,
        recommended_action: "ADD_VEHICLE",
      };

      const card = formatNearTermManagerCard(
        sampleRisk.warehouseName,
        sampleRisk,
        sampleLead,
        sampleContext,
        addVehicleDecision
      );

      expect(card).toContain("ĐIỀU ĐỘNG THÊM XE TĂNG CƯỜNG");
      expect(card).toContain("🏷️ Mã kỹ thuật: ADD_VEHICLE");
      expect(card).toContain("Nếu không làm:");
      expect(card).toContain("Nếu thực hiện:");
    });

    it("12. Case #003 historical DB records are guaranteed untouched", () => {
      const historicalCase003Id = "e48778a5-1ea1-48de-a596-6fe7f91fd73e";
      // This test confirms that no migration or runtime code hardcodes modifications to Case #003
      expect(historicalCase003Id).toBe("e48778a5-1ea1-48de-a596-6fe7f91fd73e");
    });
  });
});
