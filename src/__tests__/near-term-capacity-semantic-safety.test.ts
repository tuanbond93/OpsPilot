import { describe, expect, it } from "vitest";
import {
  acceptLeadFact,
  buildContext,
  critique,
  formatOperationalRiskPromptSummary,
  formatSemanticManpower,
  formatSemanticOrders,
  formatSemanticVehicles,
  formatSemanticWeight,
  type AiRecommendation,
  type CurrentRisk,
  type LeadFact,
} from "@/domain/near-term-capacity";
import {
  formatNearTermFactRequest,
  formatNearTermManagerCard,
} from "@/integrations/telegram/near-term-capacity-message";

const now = new Date();
const baseFacts: CurrentRisk = {
  warehouseId: "WH-YENBAI",
  warehouseName: "Kho Giao Hàng Nặng - TP Yên Bái - Yên Bái",
  capturedAt: now.toISOString(),
  currentOrders: 6,
  currentKg: null,
  b2bOrders: null,
  evidenceRefs: ["incident:test-1", "incident_history:test-1"],
  riskSignals: ["KHO_TON"],
  hardSlaConstraint: "Persisted warehouse backlog risk",
};

const baseLead: LeadFact = {
  interactionId: "telegram:msg-1",
  suppliedBy: "lead:user-1",
  capturedAt: now.toISOString(),
  source: "HUMAN_OPERATIONAL_GROUND_TRUTH",
  incoming: "NO_SIGNIFICANT_INCOMING",
  expectedIncomingKg: null,
  expectedIncomingAt: null,
  incomingType: null,
  availableVehicles: null,
  availableManpower: null,
  confidence: "HIGH",
};

const policy = {
  nearTermWindowMinutes: 240,
  leadFactMaxAgeMinutes: 60,
  allowedActions: [
    "NO_ACTION_MONITOR",
    "ADD_VEHICLE",
    "HOLD_LOW_PRIORITY_ECOM",
    "ADD_MANPOWER",
    "REALLOCATE_AVAILABLE_CAPACITY",
    "HUMAN_INVESTIGATION_REQUIRED",
  ] as const,
};

function makeRecommendation(overrides: Partial<AiRecommendation> = {}): AiRecommendation {
  return {
    decision_case_id: overrides.decision_case_id ?? "e2524b83-4462-4238-8914-cd371ab51106",
    recommended_action: "NO_ACTION_MONITOR",
    confidence: 0.85,
    reason_summary: "Tồn kho trong giới hạn kiểm soát và không có hàng lớn phát sinh trong 4h tới theo xác nhận từ Lead.",
    current_risk: formatOperationalRiskPromptSummary(baseFacts),
    expected_state_if_no_action: "Tồn kho được giải tỏa dần theo ca làm việc tiêu chuẩn.",
    expected_state_if_action: "Đảm bảo SLA ổn định mà không phát sinh chi phí xe ngoài.",
    key_evidence: ["incident:test-1"],
    uncertainties: [],
    execution_instruction: "Theo dõi tiến độ xuất hàng tại trạm qua các checkpoint tiếp theo.",
    required_by: new Date(now.getTime() + 7200_000).toISOString(),
    required_followup_at: new Date(now.getTime() + 14400_000).toISOString(),
    estimated_cost_vnd: null,
    estimated_saving_vnd: null,
    ...overrides,
  };
}

describe("UNKNOWN ≠ ZERO Semantic Safety Contract", () => {
  describe("formatSemanticWeight", () => {
    it("renders null as 'Chưa có dữ liệu kg'", () => {
      expect(formatSemanticWeight(null)).toBe("Chưa có dữ liệu kg");
    });

    it("renders undefined as 'Chưa có dữ liệu kg'", () => {
      expect(formatSemanticWeight(undefined)).toBe("Chưa có dữ liệu kg");
    });

    it("renders genuine 0 as '0 kg', NEVER as missing placeholder", () => {
      expect(formatSemanticWeight(0)).toBe("0 kg");
      expect(formatSemanticWeight(0)).not.toBe("Chưa có dữ liệu kg");
    });

    it("renders positive numeric values with kg suffix", () => {
      expect(formatSemanticWeight(450)).toBe("450 kg");
      expect(formatSemanticWeight(12.7)).toBe("12.7 kg");
    });
  });

  describe("formatSemanticOrders", () => {
    it("renders null and undefined as missing indicator", () => {
      expect(formatSemanticOrders(null)).toBe("Chưa có dữ liệu đơn");
      expect(formatSemanticOrders(undefined)).toBe("Chưa có dữ liệu đơn");
    });

    it("renders genuine 0 as '0 đơn'", () => {
      expect(formatSemanticOrders(0)).toBe("0 đơn");
    });

    it("renders positive order counts with đơn suffix", () => {
      expect(formatSemanticOrders(6)).toBe("6 đơn");
      expect(formatSemanticOrders(15)).toBe("15 đơn");
    });
  });

  describe("formatSemanticVehicles and formatSemanticManpower", () => {
    it("renders missing capacity facts honestly", () => {
      expect(formatSemanticVehicles(null)).toBe("Chưa có dữ liệu xe");
      expect(formatSemanticVehicles(undefined)).toBe("Chưa có dữ liệu xe");
      expect(formatSemanticManpower(null)).toBe("Chưa có dữ liệu nhân sự");
      expect(formatSemanticManpower(undefined)).toBe("Chưa có dữ liệu nhân sự");
    });

    it("renders genuine 0 capacity correctly", () => {
      expect(formatSemanticVehicles(0)).toBe("0 xe");
      expect(formatSemanticManpower(0)).toBe("0 người");
    });

    it("renders positive capacity quantities correctly", () => {
      expect(formatSemanticVehicles(2)).toBe("2 xe");
      expect(formatSemanticManpower(5)).toBe("5 người");
    });
  });

  describe("formatOperationalRiskPromptSummary", () => {
    it("renders null kg as 'CHƯA CÓ DỮ LIỆU' in prompt, never numeric 0", () => {
      const summary = formatOperationalRiskPromptSummary({ currentOrders: 6, currentKg: null });
      expect(summary).toBe("Tồn kho: 6 đơn; khối lượng: CHƯA CÓ DỮ LIỆU.");
      expect(summary).not.toContain("0 kg");
    });

    it("renders both null orders and null kg as 'CHƯA CÓ DỮ LIỆU'", () => {
      const summary = formatOperationalRiskPromptSummary({ currentOrders: null, currentKg: null });
      expect(summary).toBe("Tồn kho: CHƯA CÓ DỮ LIỆU; khối lượng: CHƯA CÓ DỮ LIỆU.");
    });

    it("preserves genuine 0 values when they actually occur", () => {
      const summary = formatOperationalRiskPromptSummary({ currentOrders: 0, currentKg: 0 });
      expect(summary).toBe("Tồn kho: 0 đơn; khối lượng: 0 kg.");
    });
  });

  describe("FactDataStatus markers in buildContext and acceptLeadFact", () => {
    it("tags currentKgStatus as UNKNOWN when currentKg is null", () => {
      const context = buildContext("case-unknown", baseFacts, baseLead, policy);
      expect(context.facts.currentKgStatus).toBe("UNKNOWN");
      expect(context.facts.currentOrdersStatus).toBe("AVAILABLE");
    });

    it("tags currentKgStatus as AVAILABLE when currentKg is 0 or positive", () => {
      const contextZero = buildContext("case-zero", { ...baseFacts, currentKg: 0 }, baseLead, policy);
      expect(contextZero.facts.currentKgStatus).toBe("AVAILABLE");

      const contextPositive = buildContext("case-pos", { ...baseFacts, currentKg: 450 }, baseLead, policy);
      expect(contextPositive.facts.currentKgStatus).toBe("AVAILABLE");
    });

    it("tags lead capacity statuses in acceptLeadFact", () => {
      const accepted = acceptLeadFact(null, baseLead);
      expect(accepted.expectedIncomingKgStatus).toBe("UNKNOWN");
      expect(accepted.availableVehiclesStatus).toBe("UNKNOWN");
      expect(accepted.availableManpowerStatus).toBe("UNKNOWN");

      const acceptedWithValues = acceptLeadFact(null, {
        ...baseLead,
        expectedIncomingKg: 200,
        availableVehicles: 0,
        availableManpower: 2,
      });
      expect(acceptedWithValues.expectedIncomingKgStatus).toBe("AVAILABLE");
      expect(acceptedWithValues.availableVehiclesStatus).toBe("AVAILABLE");
      expect(acceptedWithValues.availableManpowerStatus).toBe("AVAILABLE");
    });
  });

  describe("Deterministic Critic Rules for Fact Dependencies", () => {
    it("vetoes ADD_VEHICLE when volume is unknown", () => {
      const context = buildContext("case-novol", baseFacts, baseLead, policy);
      const rec = makeRecommendation({ decision_case_id: context.decisionCaseId, recommended_action: "ADD_VEHICLE" });
      const critic = critique(context, rec);

      expect(critic.verdict).toBe("HUMAN_INVESTIGATION_REQUIRED");
      expect(critic.reasons).toContain("INTERVENTION_ACTION_REQUIRES_KNOWN_VOLUME");
    });

    it("vetoes HOLD_LOW_PRIORITY_ECOM when volume is unknown", () => {
      const context = buildContext("case-novol", baseFacts, baseLead, policy);
      const rec = makeRecommendation({ decision_case_id: context.decisionCaseId, recommended_action: "HOLD_LOW_PRIORITY_ECOM" });
      const critic = critique(context, rec);

      expect(critic.verdict).toBe("HUMAN_INVESTIGATION_REQUIRED");
      expect(critic.reasons).toContain("INTERVENTION_ACTION_REQUIRES_KNOWN_VOLUME");
    });

    it("allows NO_ACTION_MONITOR under uncertainty when volume is unknown and Lead confirms NO_SIGNIFICANT_INCOMING", () => {
      const context = buildContext("case-safe", baseFacts, baseLead, policy);
      const rec = makeRecommendation({ decision_case_id: context.decisionCaseId, recommended_action: "NO_ACTION_MONITOR" });
      const critic = critique(context, rec);

      expect(critic.verdict).toBe("VALID_DECISION");
      expect(critic.reasons).toEqual([]);
    });

    it("allows ADD_VEHICLE when volume is known via currentKg", () => {
      const knownFacts: CurrentRisk = { ...baseFacts, currentKg: 450 };
      const leadWithEta: LeadFact = {
        ...baseLead,
        incoming: "CONFIRMED_ETA",
        expectedIncomingKg: 100,
        expectedIncomingAt: new Date(now.getTime() + 60_000).toISOString(),
        incomingType: "MIXED",
      };
      const context = buildContext("case-known", knownFacts, leadWithEta, policy);
      const rec = makeRecommendation({
        decision_case_id: context.decisionCaseId,
        recommended_action: "ADD_VEHICLE",
        key_evidence: ["incident:test-1"],
      });
      const critic = critique(context, rec);

      expect(critic.verdict).toBe("VALID_DECISION");
      expect(critic.reasons).toEqual([]);
    });

    it("vetoes REALLOCATE_AVAILABLE_CAPACITY when available capacity facts are missing", () => {
      const knownFacts: CurrentRisk = { ...baseFacts, currentKg: 450 };
      const leadWithoutCapacity: LeadFact = {
        ...baseLead,
        availableVehicles: null,
        availableManpower: null,
      };
      const context = buildContext("case-realloc", knownFacts, leadWithoutCapacity, policy);
      const rec = makeRecommendation({ decision_case_id: context.decisionCaseId, recommended_action: "REALLOCATE_AVAILABLE_CAPACITY" });
      const critic = critique(context, rec);

      expect(critic.verdict).toBe("HUMAN_INVESTIGATION_REQUIRED");
      expect(critic.reasons).toContain("REALLOCATION_REQUIRES_AVAILABLE_CAPACITY_FACTS");
    });
  });

  describe("Telegram Manager Card and Fact Request Rendering", () => {
    it("renders Manager Card with 'Chưa có dữ liệu kg / 6 đơn' and no fake 0 kg", () => {
      const context = buildContext("case-card", baseFacts, baseLead, policy);
      const rec = makeRecommendation({ decision_case_id: context.decisionCaseId });
      const card = formatNearTermManagerCard(baseFacts.warehouseName, baseFacts, baseLead, context, rec);

      expect(card).toContain("• Hiện tại: Chưa có dữ liệu kg / 6 đơn");
      expect(card).not.toMatch(/• Hiện tại: 0 kg \/ 6 đơn/);
      expect(card).not.toContain("Tồn kho 0 kg");
    });

    it("renders Manager Card with genuine 0 kg when currentKg is 0", () => {
      const zeroFacts: CurrentRisk = { ...baseFacts, currentKg: 0 };
      const context = buildContext("case-card-zero", zeroFacts, baseLead, policy);
      const rec = makeRecommendation({ decision_case_id: context.decisionCaseId, current_risk: formatOperationalRiskPromptSummary(zeroFacts) });
      const card = formatNearTermManagerCard(zeroFacts.warehouseName, zeroFacts, baseLead, context, rec);

      expect(card).toContain("• Hiện tại: 0 kg / 6 đơn");
      expect(card).not.toContain("Chưa có dữ liệu kg / 6 đơn");
    });

    it("renders Fact Request with 'Chưa có dữ liệu kg' and '6 đơn'", () => {
      const factRequest = formatNearTermFactRequest(baseFacts, 240);

      expect(factRequest).toContain("• Đang tồn: 6 đơn");
      expect(factRequest).toContain("• Tổng khối lượng: Chưa có dữ liệu kg");
      expect(factRequest).not.toMatch(/• Tổng khối lượng: 0 kg/);
      expect(factRequest).toContain("Thiếu dữ liệu khối lượng; cần Lead xác nhận thêm");
    });
  });

  describe("Historical Golden Case Immutability", () => {
    it("preserves Golden Case #001 as immutable without rewriting decision", () => {
      // Golden Case production state
      const goldenCase = {
        id: "e2524b83-4462-4238-8914-cd371ab51106",
        status: "DECISION_READY",
        decision_id: "92d8e19c-db9e-4840-8914-cd371ab51106",
        telegram_message_id: 1313,
        current_risk_snapshot: baseFacts,
        lead_fact_snapshot: baseLead,
      };

      // Decision and snapshot remain unchanged
      expect(goldenCase.status).toBe("DECISION_READY");
      expect(goldenCase.decision_id).toBe("92d8e19c-db9e-4840-8914-cd371ab51106");
      expect(goldenCase.current_risk_snapshot.currentKg).toBeNull();
      expect(goldenCase.current_risk_snapshot.currentOrders).toBe(6);
      expect(goldenCase.telegram_message_id).toBe(1313);
    });
  });
});
