/**
 * Phase 2's bounded decision family.  This module intentionally has no
 * transport or database dependency: adapters persist the immutable snapshots
 * and Phase 1 owns the actual work-order/follow-up delivery.
 */
export const CAPACITY_ACTIONS = [
  "NO_ACTION_MONITOR", "ADD_VEHICLE", "HOLD_LOW_PRIORITY_ECOM", "ADD_MANPOWER",
  "REALLOCATE_AVAILABLE_CAPACITY", "HUMAN_INVESTIGATION_REQUIRED",
] as const;
export type CapacityAction = typeof CAPACITY_ACTIONS[number];
export type IncomingAnswer = "CONFIRMED_ETA" | "UNCERTAIN_ETA" | "NO_SIGNIFICANT_INCOMING" | "UNKNOWN";
export type Outcome = "SUCCESS" | "FAILURE" | "INCONCLUSIVE";

export type FactDataStatus = "AVAILABLE" | "UNKNOWN";

export type CurrentRisk = {
  warehouseId: string; warehouseName: string; capturedAt: string;
  currentOrders: number | null; currentKg: number | null; b2bOrders: number | null;
  currentKgStatus?: FactDataStatus;
  currentOrdersStatus?: FactDataStatus;
  /** Persisted operational evidence IDs (checkpoint/incident/Rillnet snapshot). */
  evidenceRefs: string[];
  /** A conservative detector needs an existing, explainable risk signal. */
  riskSignals: string[];
  hardSlaConstraint?: string | null;
  /** Optional source-backed details for the human fact request only. */
  orderCodes?: string[];
  supportingChange?: string | null;
};
export type LeadFact = {
  interactionId: string; suppliedBy: string; capturedAt: string;
  source: "HUMAN_OPERATIONAL_GROUND_TRUTH"; incoming: IncomingAnswer;
  expectedIncomingKg?: number | null; expectedIncomingAt?: string | null;
  incomingType?: "B2B" | "ECOM" | "MIXED" | null;
  availableVehicles?: number | null; availableManpower?: number | null;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  supportingNote?: string | null;
  expectedIncomingKgStatus?: FactDataStatus;
  availableVehiclesStatus?: FactDataStatus;
  availableManpowerStatus?: FactDataStatus;
};
export type CapacityPolicy = { nearTermWindowMinutes: number; leadFactMaxAgeMinutes: number; allowedActions: readonly CapacityAction[] };
export type DecisionContext = { decisionCaseId: string; facts: CurrentRisk; humanGroundTruth: LeadFact | null; policy: CapacityPolicy; uncertainties: string[]; allowedActions: CapacityAction[] };
export type AiRecommendation = {
  decision_case_id: string; recommended_action: CapacityAction; confidence: number;
  reason_summary: string; current_risk: string; expected_state_if_no_action: string;
  expected_state_if_action: string; key_evidence: string[]; uncertainties: string[];
  execution_instruction: string; required_by: string; required_followup_at: string;
  estimated_cost_vnd: number | null; estimated_saving_vnd: number | null;
};
export type CriticResult = { verdict: "VALID_DECISION" | "HUMAN_INVESTIGATION_REQUIRED"; reasons: string[] };

/**
 * Strict operational semantic formatters: UNKNOWN ≠ ZERO.
 * Genuine 0 values are preserved as "0 <unit>".
 * null / undefined values explicitly indicate missing data.
 */
export function formatSemanticWeight(kg: number | null | undefined, placeholder = "Chưa có dữ liệu kg"): string {
  if (kg == null || !Number.isFinite(kg)) return placeholder;
  return `${kg} kg`;
}

export function formatSemanticOrders(orders: number | null | undefined, placeholder = "Chưa có dữ liệu đơn"): string {
  if (orders == null || !Number.isFinite(orders)) return placeholder;
  return `${orders} đơn`;
}

export function formatSemanticVehicles(vehicles: number | null | undefined, placeholder = "Chưa có dữ liệu xe"): string {
  if (vehicles == null || !Number.isFinite(vehicles)) return placeholder;
  return `${vehicles} xe`;
}

export function formatSemanticManpower(manpower: number | null | undefined, placeholder = "Chưa có dữ liệu nhân sự"): string {
  if (manpower == null || !Number.isFinite(manpower)) return placeholder;
  return `${manpower} người`;
}

export function formatOperationalRiskPromptSummary(facts: Pick<CurrentRisk, "currentOrders" | "currentKg">): string {
  const ordersText = facts.currentOrders == null ? "CHƯA CÓ DỮ LIỆU" : `${facts.currentOrders} đơn`;
  const kgText = facts.currentKg == null ? "CHƯA CÓ DỮ LIỆU" : `${facts.currentKg} kg`;
  return `Tồn kho: ${ordersText}; khối lượng: ${kgText}.`;
}

const finiteNonNegative = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const validDate = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));

/** Never manufactures an overload threshold: a candidate requires persisted risk evidence. */
export function detectCandidate(fact: CurrentRisk): boolean {
  return validDate(fact.capturedAt) && fact.evidenceRefs.length > 0 && fact.riskSignals.length > 0 &&
    (finiteNonNegative(fact.currentOrders) || finiteNonNegative(fact.currentKg));
}

export function factRequestNeeded(fact: CurrentRisk): boolean { return detectCandidate(fact); }

/** FIRST_RESPONSE_WINS is enforced before a fact can overwrite its interaction. */
export function acceptLeadFact(existing: LeadFact | null, next: LeadFact): LeadFact {
  if (existing) return existing;
  if (!next.interactionId || !next.suppliedBy || !validDate(next.capturedAt)) throw new Error("INVALID_LEAD_FACT");
  if (next.source !== "HUMAN_OPERATIONAL_GROUND_TRUTH") throw new Error("INVALID_FACT_SOURCE");
  if (next.expectedIncomingKg != null && !finiteNonNegative(next.expectedIncomingKg)) throw new Error("INVALID_INCOMING_KG");
  if (next.expectedIncomingAt != null && !validDate(next.expectedIncomingAt)) throw new Error("INVALID_INCOMING_TIMESTAMP");
  if (next.availableVehicles != null && !finiteNonNegative(next.availableVehicles)) throw new Error("INVALID_AVAILABLE_VEHICLES");
  if (next.availableManpower != null && !finiteNonNegative(next.availableManpower)) throw new Error("INVALID_AVAILABLE_MANPOWER");
  return Object.freeze({
    ...next,
    expectedIncomingKgStatus: next.expectedIncomingKg == null ? "UNKNOWN" : "AVAILABLE",
    availableVehiclesStatus: next.availableVehicles == null ? "UNKNOWN" : "AVAILABLE",
    availableManpowerStatus: next.availableManpower == null ? "UNKNOWN" : "AVAILABLE",
  });
}

export function precheck(facts: CurrentRisk, lead: LeadFact | null, policy: CapacityPolicy, now = new Date()): string[] {
  const errors: string[] = [];
  if (!detectCandidate(facts)) errors.push("CURRENT_RISK_EVIDENCE_MISSING");
  if (!lead) return [...errors, "LEAD_FACT_MISSING"];
  if (now.getTime() - Date.parse(lead.capturedAt) > policy.leadFactMaxAgeMinutes * 60_000) errors.push("LEAD_FACT_STALE");
  if (lead.expectedIncomingAt && Date.parse(lead.expectedIncomingAt) < Date.parse(facts.capturedAt)) errors.push("INCOMING_TIMESTAMP_IMPOSSIBLE");
  if (["CONFIRMED_ETA", "UNCERTAIN_ETA"].includes(lead.incoming) && (lead.expectedIncomingKg == null || !lead.incomingType)) errors.push("INCOMING_FACT_INCOMPLETE");
  return errors;
}

export function allowedActions(fact: CurrentRisk, lead: LeadFact | null, policy: CapacityPolicy, now = new Date()): CapacityAction[] {
  if (precheck(fact, lead, policy, now).length) return ["HUMAN_INVESTIGATION_REQUIRED"];
  if (lead!.incoming === "NO_SIGNIFICANT_INCOMING") return ["NO_ACTION_MONITOR"];
  const permitted = new Set(policy.allowedActions);
  const actions: CapacityAction[] = ["NO_ACTION_MONITOR", "HUMAN_INVESTIGATION_REQUIRED"];
  if (permitted.has("ADD_VEHICLE")) actions.push("ADD_VEHICLE");
  if (permitted.has("HOLD_LOW_PRIORITY_ECOM") && lead!.incomingType !== "B2B") actions.push("HOLD_LOW_PRIORITY_ECOM");
  if (permitted.has("ADD_MANPOWER")) actions.push("ADD_MANPOWER");
  if (permitted.has("REALLOCATE_AVAILABLE_CAPACITY") && ((lead!.availableVehicles || 0) > 0 || (lead!.availableManpower || 0) > 0)) actions.push("REALLOCATE_AVAILABLE_CAPACITY");
  return [...new Set(actions)];
}

export function buildContext(id: string, facts: CurrentRisk, lead: LeadFact | null, policy: CapacityPolicy, now = new Date()): DecisionContext {
  const errors = precheck(facts, lead, policy, now);
  const currentKgStatus: FactDataStatus = facts.currentKg == null ? "UNKNOWN" : "AVAILABLE";
  const currentOrdersStatus: FactDataStatus = facts.currentOrders == null ? "UNKNOWN" : "AVAILABLE";
  const enrichedFacts: CurrentRisk = {
    ...facts,
    currentKgStatus,
    currentOrdersStatus,
  };
  return {
    decisionCaseId: id,
    facts: enrichedFacts,
    humanGroundTruth: lead,
    policy,
    uncertainties: errors,
    allowedActions: allowedActions(facts, lead, policy, now),
  };
}

export function critique(context: DecisionContext, recommendation: AiRecommendation): CriticResult {
  const reasons: string[] = [];
  if (recommendation.decision_case_id !== context.decisionCaseId) reasons.push("CASE_ID_MISMATCH");
  if (!context.allowedActions.includes(recommendation.recommended_action)) reasons.push("ACTION_NOT_ALLOWED");
  if (!Number.isFinite(recommendation.confidence) || recommendation.confidence < 0 || recommendation.confidence > 1) reasons.push("INVALID_CONFIDENCE");
  if (!recommendation.key_evidence.length || recommendation.key_evidence.some((ref) => !context.facts.evidenceRefs.includes(ref))) reasons.push("UNVERIFIED_EVIDENCE_REFERENCE");
  if (recommendation.estimated_cost_vnd !== null || recommendation.estimated_saving_vnd !== null) reasons.push("UNSUPPORTED_FINANCIAL_VALUE");
  if (!validDate(recommendation.required_by) || !validDate(recommendation.required_followup_at)) reasons.push("INVALID_REQUIRED_TIMESTAMP");
  if (validDate(recommendation.required_by) && validDate(recommendation.required_followup_at) && Date.parse(recommendation.required_followup_at) < Date.parse(recommendation.required_by)) reasons.push("FOLLOWUP_BEFORE_REQUIRED_BY");
  if (context.uncertainties.length && recommendation.recommended_action !== "HUMAN_INVESTIGATION_REQUIRED") reasons.push("CRITICAL_PRECHECK_FAILED");

  // Deterministic rule: Intervention actions materially depending on missing critical facts must not pass
  const actionRequiresVolume = recommendation.recommended_action === "ADD_VEHICLE" || recommendation.recommended_action === "HOLD_LOW_PRIORITY_ECOM";
  const volumeMissing = context.facts.currentKg == null && (context.humanGroundTruth?.expectedIncomingKg == null);
  if (actionRequiresVolume && volumeMissing) {
    reasons.push("INTERVENTION_ACTION_REQUIRES_KNOWN_VOLUME");
  }

  const actionRequiresReallocation = recommendation.recommended_action === "REALLOCATE_AVAILABLE_CAPACITY";
  const reallocationMissing = context.humanGroundTruth?.availableVehicles == null && context.humanGroundTruth?.availableManpower == null;
  if (actionRequiresReallocation && reallocationMissing) {
    reasons.push("REALLOCATION_REQUIRES_AVAILABLE_CAPACITY_FACTS");
  }

  return { verdict: reasons.length ? "HUMAN_INVESTIGATION_REQUIRED" : "VALID_DECISION", reasons };
}

export function executionInstruction(action: CapacityAction, detail: string): string {
  if (!detail.trim()) throw new Error("EXECUTION_DETAIL_REQUIRED");
  if (action === "NO_ACTION_MONITOR" || action === "HUMAN_INVESTIGATION_REQUIRED") throw new Error("NON_EXECUTABLE_ACTION");
  return detail.trim(); // Phase 1 uses this exact approved instruction in its existing work-order contract.
}

export function verifyCapacityOutcome(input: { actionExecuted: "YES" | "NO" | "UNKNOWN"; slaOutcome: "PRESERVED" | "BREACHED" | "UNKNOWN"; riskAfterAction: "REDUCED" | "NOT_REDUCED" | "UNKNOWN" }): Outcome {
  if (input.actionExecuted === "YES" && input.slaOutcome === "PRESERVED" && input.riskAfterAction === "REDUCED") return "SUCCESS";
  if (input.actionExecuted === "NO" || input.slaOutcome === "BREACHED" || input.riskAfterAction === "NOT_REDUCED") return "FAILURE";
  return "INCONCLUSIVE";
}
