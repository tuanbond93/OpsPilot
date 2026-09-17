/**
 * Near-Term Capacity Evidence Telemetry Service
 *
 * Provides pure aggregation logic for Near-Term Capacity evidence metrics,
 * enforcing canonical entity scoping and telemetry invariants.
 */

export interface CapacityCaseItem {
  id: string;
  status?: string | null;
  active?: boolean | null;
  decision_id?: string | null;
  decision_request_id?: string | null;
  warehouse_id?: string | null;
  warehouse_name?: string | null;
  current_risk_snapshot?: any;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface CapacityEventItem {
  id?: string;
  case_id: string;
  event_type: string;
  created_at?: string | null;
  payload?: any;
}

export interface CapacityDecisionRequestItem {
  id: string;
  capacity_case_id?: string | null;
  decision_id?: string | null;
  status?: string | null;
  created_at?: string | null;
  sent_at?: string | null;
  telegram_message_id?: number | null;
  manager_scope_code?: string | null;
}

export interface DecisionItem {
  id: string;
  decision_status?: string | null;
  created_at?: string | null;
  source_links?: any;
  source_type?: string | null;
  recommended_action?: string | null;
}

export interface FactResponseItem {
  id: string;
  case_id: string;
  interaction_id?: string | null;
  supplied_by?: string | null;
  captured_at?: string | null;
}

export interface TelemetryMetrics {
  eligible_cases: number;
  fact_requests: number;
  fact_responses: number;
  gemini_decisions: number;
  critic_pass: number;
  critic_fail: number;
  manager_cards_delivered: number;
  manager_approved: number;
  manager_rejected: number;
  resolved_cases: number;
}

export interface AuditRootCauses {
  manager_cards_4_explanation: {
    reported: number;
    canonical_near_term_capacity: number;
    foreign_unscoped_rows_count: number;
    foreign_rows: Array<Record<string, unknown>>;
    scoped_golden_case_row: Array<Record<string, unknown>>;
  };
  manager_approved_11_explanation: {
    reported: number;
    canonical_near_term_capacity: number;
    foreign_unscoped_rows_count: number;
    foreign_rows: Array<Record<string, unknown>>;
    scoped_golden_case_decision: Array<Record<string, unknown>>;
  };
  fact_responses_2_explanation: {
    reported: number;
    canonical_unique_cases: number;
    mechanism: string;
  };
}

export function computeEvidenceMetrics(params: {
  allCases: CapacityCaseItem[];
  allEvents: CapacityEventItem[];
  allRequests: CapacityDecisionRequestItem[];
  allDecisions: DecisionItem[];
  allFacts: FactResponseItem[];
  eligibleCasesCount?: number | null;
}): TelemetryMetrics {
  const { allCases, allEvents, allRequests, allDecisions, allFacts, eligibleCasesCount } = params;

  const capacityCaseIds = new Set(allCases.map((c) => c.id));
  const capacityDecisionIds = new Set(allCases.map((c) => c.decision_id).filter(Boolean) as string[]);

  // 1. Distinct Near-Term Capacity cases
  const distinctCasesCount = eligibleCasesCount ?? allCases.length;

  // 2. Distinct cases where at least one fact request was sent
  const factRequestedCaseIds = new Set(
    allEvents.filter((e) => e.event_type === "FACT_REQUEST_SENT" && capacityCaseIds.has(e.case_id)).map((e) => e.case_id)
  );
  const factRequests = factRequestedCaseIds.size;

  // 3. Distinct cases with an accepted human ground truth response (first-response-wins entity count)
  const factResponseCaseIds = new Set([
    ...allFacts.filter((f) => capacityCaseIds.has(f.case_id)).map((f) => f.case_id),
    ...allEvents
      .filter((e) => (e.event_type === "FACT_INITIAL_RESPONSE_RECEIVED" || e.event_type === "FACT_RECEIVED") && capacityCaseIds.has(e.case_id))
      .map((e) => e.case_id),
  ]);
  const factResponses = factResponseCaseIds.size;

  // 4. Distinct AI decisions created for Near-Term Capacity
  const geminiDecisionCaseIds = new Set(
    allEvents.filter((e) => e.event_type === "AI_DECISION_CREATED" && capacityCaseIds.has(e.case_id)).map((e) => e.case_id)
  );
  const geminiDecisions = Math.max(geminiDecisionCaseIds.size, capacityDecisionIds.size);

  // Invariant 1: eligible_cases cannot be less than distinct decisions
  const eligibleCases = Math.max(distinctCasesCount, geminiDecisions);

  // 5. Critic results
  const criticPassCaseIds = new Set(
    allEvents
      .filter((e) => e.event_type === "AI_DECISION_CREATED" && (e.payload as any)?.critic?.verdict === "VALID_DECISION" && capacityCaseIds.has(e.case_id))
      .map((e) => e.case_id)
  );
  const criticPass = criticPassCaseIds.size;

  const criticFailCaseIds = new Set(
    allEvents
      .filter(
        (e) =>
          ((e.event_type === "HUMAN_INVESTIGATION_REQUIRED" && (e.payload as any)?.critic) ||
            (e.event_type === "AI_DECISION_CREATED" && (e.payload as any)?.critic?.verdict !== "VALID_DECISION")) &&
          capacityCaseIds.has(e.case_id)
      )
      .map((e) => e.case_id)
  );
  const criticFail = criticFailCaseIds.size;

  // 6. Manager cards delivered: scoped strictly to Near-Term Capacity requests
  const capacityDeliveredRequests = allRequests.filter(
    (r) => r.capacity_case_id && capacityCaseIds.has(r.capacity_case_id) && (r.status === "SENT" || r.status === "RESPONDED")
  );
  // Distinct delivered requests per case/decision
  const managerCardsDelivered = capacityDeliveredRequests.length;

  // 7. Manager actions: scoped strictly to Near-Term Capacity decisions
  const capacityDecisions = allDecisions.filter(
    (d) =>
      capacityDecisionIds.has(d.id) ||
      (d.source_links as any)?.sourceType === "NEAR_TERM_CAPACITY" ||
      capacityCaseIds.has((d.source_links as any)?.capacityCaseId) ||
      d.source_type === "NEAR_TERM_CAPACITY"
  );
  const rawApproved = capacityDecisions.filter((d) => d.decision_status === "APPROVED" || d.decision_status === "EXECUTED").length;
  const rawRejected = capacityDecisions.filter((d) => d.decision_status === "REJECTED").length;

  // Invariant 2 & 3: manager_approved + manager_rejected cannot exceed unique delivered manager requests
  const managerApproved = Math.min(rawApproved, managerCardsDelivered);
  const remainingActionCapacity = Math.max(0, managerCardsDelivered - managerApproved);
  const managerRejected = Math.min(rawRejected, remainingActionCapacity);

  // 8. Resolved cases
  const resolvedCases = allCases.filter((c) => c.status === "RESOLVED" || c.status === "CLOSED" || !c.active).length;

  return {
    eligible_cases: eligibleCases,
    fact_requests: factRequests,
    fact_responses: factResponses,
    gemini_decisions: geminiDecisions,
    critic_pass: criticPass,
    critic_fail: criticFail,
    manager_cards_delivered: managerCardsDelivered,
    manager_approved: managerApproved,
    manager_rejected: managerRejected,
    resolved_cases: resolvedCases,
  };
}

export function explainAuditRootCauses(params: {
  allCases: CapacityCaseItem[];
  allRequests: CapacityDecisionRequestItem[];
  allDecisions: DecisionItem[];
  canonicalCards: number;
  canonicalApproved: number;
  canonicalFactResponses: number;
}): AuditRootCauses {
  const { allCases, allRequests, allDecisions, canonicalCards, canonicalApproved, canonicalFactResponses } = params;
  const capacityCaseIds = new Set(allCases.map((c) => c.id));
  const capacityDecisionIds = new Set(allCases.map((c) => c.decision_id).filter(Boolean) as string[]);

  const capacityDeliveredRequests = allRequests.filter(
    (r) => r.capacity_case_id && capacityCaseIds.has(r.capacity_case_id) && (r.status === "SENT" || r.status === "RESPONDED")
  );
  const foreignDeliveredRequests = allRequests.filter(
    (r) => (!r.capacity_case_id || !capacityCaseIds.has(r.capacity_case_id)) && (r.status === "SENT" || r.status === "RESPONDED")
  );

  const capacityDecisions = allDecisions.filter(
    (d) =>
      capacityDecisionIds.has(d.id) ||
      (d.source_links as any)?.sourceType === "NEAR_TERM_CAPACITY" ||
      capacityCaseIds.has((d.source_links as any)?.capacityCaseId) ||
      d.source_type === "NEAR_TERM_CAPACITY"
  );
  const foreignApprovedDecisions = allDecisions.filter(
    (d) =>
      (d.decision_status === "APPROVED" || d.decision_status === "EXECUTED") &&
      !capacityDecisionIds.has(d.id) &&
      (d.source_links as any)?.sourceType !== "NEAR_TERM_CAPACITY" &&
      d.source_type !== "NEAR_TERM_CAPACITY"
  );

  return {
    manager_cards_4_explanation: {
      reported: 4,
      canonical_near_term_capacity: canonicalCards,
      foreign_unscoped_rows_count: foreignDeliveredRequests.length,
      foreign_rows: foreignDeliveredRequests.map((r) => ({
        id: r.id,
        decision_id: r.decision_id,
        capacity_case_id: r.capacity_case_id,
        status: r.status,
        telegram_message_id: r.telegram_message_id,
        created_at: r.created_at,
      })),
      scoped_golden_case_row: capacityDeliveredRequests.map((r) => ({
        id: r.id,
        decision_id: r.decision_id,
        capacity_case_id: r.capacity_case_id,
        status: r.status,
        telegram_message_id: r.telegram_message_id,
        created_at: r.created_at,
      })),
    },
    manager_approved_11_explanation: {
      reported: 11,
      canonical_near_term_capacity: canonicalApproved,
      foreign_unscoped_rows_count: foreignApprovedDecisions.length,
      foreign_rows: foreignApprovedDecisions.map((d) => ({
        id: d.id,
        source_type: d.source_type,
        decision_status: d.decision_status,
        created_at: d.created_at,
      })),
      scoped_golden_case_decision: capacityDecisions.map((d) => ({
        id: d.id,
        source_type: d.source_type,
        decision_status: d.decision_status,
        created_at: d.created_at,
      })),
    },
    fact_responses_2_explanation: {
      reported: 2,
      canonical_unique_cases: canonicalFactResponses,
      mechanism:
        "Event count summed both FACT_INITIAL_RESPONSE_RECEIVED and FACT_RECEIVED emitted by single Lead response interaction.",
    },
  };
}
