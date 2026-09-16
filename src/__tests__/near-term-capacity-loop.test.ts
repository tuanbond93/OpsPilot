import { describe, expect, it } from "vitest";
import { CAPACITY_ACTIONS, acceptLeadFact, allowedActions, buildContext, critique, detectCandidate, executionInstruction, factRequestNeeded, precheck, verifyCapacityOutcome, type AiRecommendation, type CurrentRisk, type LeadFact } from "@/domain/near-term-capacity";
import { buildNearTermFactCallbackData, formatNearTermFactRequest, formatNearTermManagerCard, nearTermFactButtons, parseNearTermFactCallbackData } from "@/integrations/telegram/near-term-capacity-message";
import { buildCapacityDecisionCallbackData, parseCapacityDecisionCallbackData } from "@/integrations/telegram/capacity-decision-actions";
import { isRecoverableUnsentFactRequest, parseLeadDetail } from "@/services/near-term-capacity-runtime";
import fs from "node:fs";

const now = new Date();
const facts: CurrentRisk = { warehouseId: "WH-1", warehouseName: "Kho 1", capturedAt: now.toISOString(), currentOrders: 12, currentKg: 500, b2bOrders: 3, evidenceRefs: ["incident:1", "checkpoint:1"], riskSignals: ["PERSISTED_SLA_RISK"], hardSlaConstraint: "B2B due today" };
const policy = { nearTermWindowMinutes: 240, leadFactMaxAgeMinutes: 60, allowedActions: CAPACITY_ACTIONS } as const;
const lead: LeadFact = { interactionId: "telegram:1", suppliedBy: "lead:1", capturedAt: now.toISOString(), source: "HUMAN_OPERATIONAL_GROUND_TRUTH", incoming: "CONFIRMED_ETA", expectedIncomingKg: 200, expectedIncomingAt: new Date(now.getTime() + 60_000).toISOString(), incomingType: "MIXED", availableVehicles: 1, availableManpower: 0, confidence: "HIGH" };
function recommendation(overrides: Partial<AiRecommendation> = {}): AiRecommendation { return { decision_case_id: "case-1", recommended_action: "ADD_VEHICLE", confidence: .8, reason_summary: "risk", current_risk: "risk", expected_state_if_no_action: "breach", expected_state_if_action: "reduce", key_evidence: ["incident:1"], uncertainties: [], execution_instruction: "Arrange one verified vehicle", required_by: new Date(now.getTime() + 10_000).toISOString(), required_followup_at: new Date(now.getTime() + 20_000).toISOString(), estimated_cost_vnd: null, estimated_saving_vnd: null, ...overrides }; }

describe("near-term capacity decision loop", () => {
  it("recovers only an active FACT_REQUESTED case with no delivery or response", () => {
    expect(isRecoverableUnsentFactRequest({ active: true, status: "FACT_REQUESTED" }, null, null)).toBe(true);
    expect(isRecoverableUnsentFactRequest({ active: true, status: "FACT_REQUESTED" }, { id: "sent" }, null)).toBe(false);
    expect(isRecoverableUnsentFactRequest({ active: true, status: "FACT_REQUESTED" }, null, { id: "response" })).toBe(false);
    expect(isRecoverableUnsentFactRequest({ active: false, status: "FACT_REQUESTED" }, null, null)).toBe(false);
  });
  it("keeps every Phase 2 persistence table server-only with RLS and no client policy", () => { const sql = fs.readFileSync("src/database/migrations/067_near_term_capacity_decision_loop.sql", "utf8"); for (const table of ["near_term_capacity_cases", "near_term_capacity_fact_responses", "near_term_capacity_events"]) expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`); expect(sql).not.toMatch(/CREATE\s+POLICY|USING\s*\(\s*true\s*\)|WITH\s+CHECK\s*\(\s*true\s*\)/i); });
  it("detects only evidenced candidates and requests Lead facts", () => { expect(detectCandidate(facts)).toBe(true); expect(factRequestNeeded(facts)).toBe(true); expect(detectCandidate({ ...facts, riskSignals: [] })).toBe(false); });
  it("persists the first Lead fact only", () => { const first = acceptLeadFact(null, lead); expect(acceptLeadFact(first, { ...lead, incoming: "UNKNOWN" })).toBe(first); });
  it("routes missing or invalid facts to investigation", () => { expect(precheck(facts, null, policy)).toContain("LEAD_FACT_MISSING"); expect(allowedActions(facts, null, policy)).toEqual(["HUMAN_INVESTIGATION_REQUIRED"]); });
  it("builds a bounded context and accepts one valid AI decision", () => { const context = buildContext("case-1", facts, lead, policy); expect(context.allowedActions).toContain("ADD_VEHICLE"); expect(critique(context, recommendation())).toEqual({ verdict: "VALID_DECISION", reasons: [] }); });
  it("blocks unsupported actions, finance fabrication, and conflicting critic output", () => { const context = buildContext("case-1", facts, lead, policy); expect(critique(context, recommendation({ recommended_action: "ADD_VEHICLE" as any, key_evidence: ["fake"], estimated_cost_vnd: 1 }))).toMatchObject({ verdict: "HUMAN_INVESTIGATION_REQUIRED", reasons: expect.arrayContaining(["UNVERIFIED_EVIDENCE_REFERENCE", "UNSUPPORTED_FINANCIAL_VALUE"]) }); expect(critique(context, recommendation({ recommended_action: "INVENT_ACTION" as any })).reasons).toContain("ACTION_NOT_ALLOWED"); });
  it("does not expose reallocation without an actually available resource", () => { expect(allowedActions(facts, { ...lead, availableVehicles: 0, availableManpower: 0 }, policy)).not.toContain("REALLOCATE_AVAILABLE_CAPACITY"); });
  it("creates only executable Phase 1 instructions", () => { expect(executionInstruction("ADD_MANPOWER", "Prepare two confirmed sorters")).toMatch(/two/); expect(() => executionInstruction("NO_ACTION_MONITOR", "x")).toThrow("NON_EXECUTABLE_ACTION"); });
  it("verifies success, failure, and inconclusive without inventing money", () => { expect(verifyCapacityOutcome({ actionExecuted: "YES", slaOutcome: "PRESERVED", riskAfterAction: "REDUCED" })).toBe("SUCCESS"); expect(verifyCapacityOutcome({ actionExecuted: "NO", slaOutcome: "UNKNOWN", riskAfterAction: "UNKNOWN" })).toBe("FAILURE"); expect(verifyCapacityOutcome({ actionExecuted: "UNKNOWN", slaOutcome: "UNKNOWN", riskAfterAction: "UNKNOWN" })).toBe("INCONCLUSIVE"); });
  it("keeps Telegram Lead interaction factual and the Manager card evidence-based with guarded finance", () => { const factText = formatNearTermFactRequest(facts, 240); expect(factText).toContain("CẦN XÁC NHẬN"); expect(factText).not.toMatch(/nên làm gì/i); const context = buildContext("case-1", facts, lead, policy); const card = formatNearTermManagerCard(facts.warehouseName, facts, lead, context, recommendation()); expect(card).toContain("ADD_VEHICLE"); expect(card).toContain("Chưa đủ dữ liệu xác minh chi phí"); expect(card).toContain("Facts từ Lead"); expect(card).not.toContain("HOLD_LOW_PRIORITY_ECOM"); });
  it("renders bounded order and weight evidence in Vietnamese without technical labels", () => {
    const message = formatNearTermFactRequest({ ...facts, orderCodes: ["A1", "A2", "A3", "A4", "A5", "A6"], currentKg: 12.7, supportingChange: "Tồn tăng từ 2 → 6 đơn" }, 240);
    expect(message).toContain("Đang tồn: 12 đơn"); expect(message).toContain("Tổng khối lượng: 12.7 kg");
    expect(message).toContain("+ 1 đơn khác"); expect(message).toContain("Tồn tăng từ 2 → 6 đơn");
    expect(message).not.toMatch(/COT\/SLA|Persisted warehouse backlog risk|currentKg|riskSignals/);
  });
  it("states missing weight honestly and preserves the four semantic answers", () => {
    const message = formatNearTermFactRequest({ ...facts, currentKg: null, orderCodes: ["A1"] }, 240);
    expect(message).toContain("Tổng khối lượng: Chưa có dữ liệu kg");
    expect(nearTermFactButtons.map(([, answer]) => answer)).toEqual(["CONFIRMED_ETA", "UNCERTAIN_ETA", "NO_SIGNIFICANT_INCOMING", "UNKNOWN"]);
  });
  it("keeps every Lead fact callback compact, round-trippable, and legacy-compatible", () => {
    const id = "e2524b83-4462-4238-8914-cd371ab51106";
    for (const [, answer] of nearTermFactButtons) {
      const callback = buildNearTermFactCallbackData(id, answer);
      expect(Buffer.byteLength(callback)).toBeLessThanOrEqual(64);
      expect(parseNearTermFactCallbackData(callback)).toEqual({ caseId: id, answer });
    }
    expect(parseNearTermFactCallbackData(`opspcap:${id}:CONFIRMED_ETA`)).toEqual({ caseId: id, answer: "CONFIRMED_ETA" });
    expect(parseNearTermFactCallbackData(`opspcap:${id}:UNKNOWN`)).toEqual({ caseId: id, answer: "UNKNOWN" });
    expect(parseNearTermFactCallbackData(`opspcap:${id}:Z`)).toBeNull();
    expect(parseNearTermFactCallbackData("opsscap:123e4567-e89b-42d3-a456-426614174000:C")).toBeNull();
    expect(parseNearTermFactCallbackData("opspcap:not-a-uuid:C")).toBeNull();
    expect(parseNearTermFactCallbackData(`opspcap:${id}`)).toBeNull();
    expect(parseNearTermFactCallbackData(`opspcap:${id}:NO_SIGNIFICANT_INCOMING`)).toBeNull();
    expect(parseNearTermFactCallbackData(`opspcap:${id}:ADD_VEHICLE`)).toBeNull();
    expect(nearTermFactButtons.map(([label]) => label)).toEqual(["Có — biết khá chắc giờ hàng về", "Có — nhưng chưa chắc giờ hàng về", "Không có thêm đáng kể", "Chưa xác định"]);
    expect(parseLeadDetail("KG=125.5; ETA=2026-09-10T10:00:00.000Z; TYPE=MIXED")).toMatchObject({ expectedIncomingKg: 125.5, incomingType: "MIXED" });
    expect(parseLeadDetail("KG=125; TYPE=ECOM")).toBeNull();
  });
  it("uses an isolated bounded callback for a capacity manager response", () => { const id = "123e4567-e89b-42d3-a456-426614174000"; expect(parseCapacityDecisionCallbackData(buildCapacityDecisionCallbackData(id, "APPROVE"))).toEqual({ requestId: id, action: "APPROVE" }); expect(parseCapacityDecisionCallbackData(`opspcapdc:${id}:CONFIRM_SEND`)).toBeNull(); });
  it("defines a one-to-one durable bridge and atomic first-response-wins response contract", () => { const sql = fs.readFileSync("src/database/migrations/070_near_term_capacity_manager_decision_bridge.sql", "utf8"); expect(sql).toContain("capacity_case_id"); expect(sql).toContain("one_manager_request_per_near_term_capacity_case"); expect(sql).toContain("record_near_term_capacity_decision_response"); expect(sql).toContain("decision_status=CASE WHEN action='APPROVE' THEN 'APPROVED' ELSE 'REJECTED' END"); expect(sql).not.toContain("EXECUTED"); });
});
