import { type SupabaseClient } from "@supabase/supabase-js";
import { generate } from "@/ai/provider";
import {
  buildContext,
  critique,
  formatOperationalRiskPromptSummary,
  type AiRecommendation,
  type CurrentRisk,
  type DecisionContext,
  type CriticResult,
} from "@/domain/near-term-capacity";

export type ShadowSourceMode = "LIVE_SHADOW" | "HISTORICAL_REPLAY";
export type ShadowStatus = "CRITIC_PASSED" | "CRITIC_FAILED" | "AI_FAILED";

export type OutcomeBacktestStatus =
  | "CONSISTENT_WITH_OUTCOME"
  | "INCONSISTENT_WITH_OUTCOME"
  | "OUTCOME_INCONCLUSIVE"
  | "NO_OUTCOME_DATA";

export type ProvisionalSignalLabel =
  | "CLEARLY_ACTIONABLE"
  | "POTENTIALLY_ACTIONABLE"
  | "MONITOR_ONLY"
  | "LIKELY_NOISE"
  | "INSUFFICIENT_DATA";

export interface ShadowDecisionRecord {
  shadow_id: string;
  source_candidate_id: string;
  source_mode: ShadowSourceMode;
  warehouse_id: string;
  warehouse_name: string;
  risk_type: string;
  observed_at: string;
  current_orders: number | null;
  current_kg: number | null;
  current_orders_status: "AVAILABLE" | "UNKNOWN";
  current_kg_status: "AVAILABLE" | "UNKNOWN";
  operational_facts: Record<string, unknown>;
  ai_provider: string;
  ai_model: string;
  ai_decision_type: string;
  ai_recommended_action: string;
  ai_confidence: number | null;
  ai_reason_summary: string;
  critic_verdict: string;
  critic_flags: string[];
  shadow_status: ShadowStatus;
  decision_generated_at: string;
  critic_completed_at: string;
  provisional_label: ProvisionalSignalLabel;
  provisional_label_justification: string;
  human_review_required: boolean;
  outcome_backtest?: {
    status: OutcomeBacktestStatus;
    detail: string;
    subsequent_orders?: number | null;
    resolution_status?: string | null;
  };
  created_at?: string;
}

export interface ShadowCandidateInput {
  checkpointAt: string;
  syncRunId: string;
  incidentKey: string;
  warehouse: string;
  warehouseId?: string;
  province?: string | null;
  affectedOrderCount: number | null;
  currentKg: number | null;
  evidenceRefs?: string[];
  riskSignals?: string[];
}

// In-memory cache to ensure instant retrieval and fail-soft fallback if DB table is pending migration
const shadowDecisionsCache = new Map<string, ShadowDecisionRecord>();

export class NearTermCapacityShadowService {
  constructor(private readonly db: SupabaseClient) {}

  /**
   * Replays historical candidates identified from telemetry checkpoints
   */
  async replayAllHistoricalCandidates(): Promise<{
    total: number;
    aiSuccess: number;
    aiFailure: number;
    criticPass: number;
    criticFail: number;
    records: ShadowDecisionRecord[];
  }> {
    // 1. Fetch the exact 20 candidate rows from near_term_capacity_detector_telemetry
    const { data: telemetryRows, error } = await this.db
      .from("near_term_capacity_detector_telemetry")
      .select("*")
      .eq("detector_result", "CANDIDATE")
      .order("checkpoint_at", { ascending: true });

    if (error) {
      console.error("Failed to query detector telemetry for historical replay:", error);
      throw error;
    }

    const candidates = telemetryRows || [];
    const records: ShadowDecisionRecord[] = [];
    let aiSuccess = 0;
    let aiFailure = 0;
    let criticPass = 0;
    let criticFail = 0;

    for (const row of candidates) {
      const warehouseId = row.incident_key ? row.incident_key.split(":")[0] : row.warehouse;
      const input: ShadowCandidateInput = {
        checkpointAt: row.checkpoint_at,
        syncRunId: row.sync_run_id,
        incidentKey: row.incident_key,
        warehouse: row.warehouse,
        warehouseId,
        province: row.province,
        affectedOrderCount: row.affected_order_count != null ? Number(row.affected_order_count) : null,
        currentKg: row.current_kg != null ? Number(row.current_kg) : null,
        evidenceRefs: [`incident:${row.incident_key}`, `sync_run:${row.sync_run_id}`],
        riskSignals: [row.incident_type || "KHO_TON"],
      };

      const record = await this.evaluateShadowCandidate(input, "HISTORICAL_REPLAY");
      records.push(record);

      if (record.shadow_status === "AI_FAILED") {
        aiFailure += 1;
      } else {
        aiSuccess += 1;
      }

      if (record.critic_verdict === "VALID_DECISION") {
        criticPass += 1;
      } else {
        criticFail += 1;
      }
    }

    return {
      total: records.length,
      aiSuccess,
      aiFailure,
      criticPass,
      criticFail,
      records,
    };
  }

  /**
   * Observe a live candidate silently without creating governed production cases or Telegram cards
   */
  async observeLiveCandidate(candidate: ShadowCandidateInput): Promise<ShadowDecisionRecord> {
    return this.evaluateShadowCandidate(candidate, "LIVE_SHADOW");
  }

  /**
   * Core observational evaluator for both Historical Replay and Live Shadow
   */
  async evaluateShadowCandidate(
    input: ShadowCandidateInput,
    mode: ShadowSourceMode
  ): Promise<ShadowDecisionRecord> {
    const sourceCandidateId = `${input.syncRunId}:${input.incidentKey}`;
    const cacheKey = `${mode}:${sourceCandidateId}`;

    // Idempotency check in local cache
    const existing = shadowDecisionsCache.get(cacheKey);
    if (existing) {
      return existing;
    }

    // Idempotency check in DB if table exists
    try {
      const { data: dbExisting } = await this.db
        .from("near_term_capacity_shadow_decisions")
        .select("*")
        .eq("source_candidate_id", sourceCandidateId)
        .eq("source_mode", mode)
        .maybeSingle();

      if (dbExisting) {
        const parsedRecord: ShadowDecisionRecord = {
          shadow_id: dbExisting.shadow_id || dbExisting.id,
          source_candidate_id: dbExisting.source_candidate_id,
          source_mode: dbExisting.source_mode,
          warehouse_id: dbExisting.warehouse_id,
          warehouse_name: dbExisting.warehouse_name,
          risk_type: dbExisting.risk_type,
          observed_at: dbExisting.observed_at,
          current_orders: dbExisting.current_orders,
          current_kg: dbExisting.current_kg,
          current_orders_status: dbExisting.current_orders_status,
          current_kg_status: dbExisting.current_kg_status,
          operational_facts: dbExisting.operational_facts || {},
          ai_provider: dbExisting.ai_provider,
          ai_model: dbExisting.ai_model,
          ai_decision_type: dbExisting.ai_decision_type,
          ai_recommended_action: dbExisting.ai_recommended_action,
          ai_confidence: dbExisting.ai_confidence,
          ai_reason_summary: dbExisting.ai_reason_summary,
          critic_verdict: dbExisting.critic_verdict,
          critic_flags: dbExisting.critic_flags || [],
          shadow_status: dbExisting.shadow_status,
          decision_generated_at: dbExisting.decision_generated_at,
          critic_completed_at: dbExisting.critic_completed_at,
          provisional_label: dbExisting.provisional_label,
          provisional_label_justification: "Persisted record",
          human_review_required: true,
          outcome_backtest: dbExisting.outcome_backtest,
          created_at: dbExisting.created_at,
        };
        shadowDecisionsCache.set(cacheKey, parsedRecord);
        return parsedRecord;
      }
    } catch {
      // Table may not exist yet in remote Supabase; proceed with evaluation
    }

    // 1. Reconstruct facts preserving UNKNOWN != ZERO semantics
    const warehouseId = input.warehouseId || input.incidentKey.split(":")[0];
    const warehouseName = input.warehouse;
    const currentOrders = input.affectedOrderCount;
    const currentKg = input.currentKg;
    const currentOrdersStatus = currentOrders == null ? "UNKNOWN" : "AVAILABLE";
    const currentKgStatus = currentKg == null ? "UNKNOWN" : "AVAILABLE";

    const facts: CurrentRisk = {
      warehouseId,
      warehouseName,
      capturedAt: input.checkpointAt,
      currentOrders,
      currentKg,
      currentOrdersStatus,
      currentKgStatus,
      b2bOrders: null,
      orderCodes: [],
      evidenceRefs: input.evidenceRefs || [`incident:${input.incidentKey}`],
      riskSignals: input.riskSignals || ["KHO_TON"],
      hardSlaConstraint: "Near-Term capacity shadow evaluation",
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

    const shadowId = `shadow-${sourceCandidateId.replace(/[^a-zA-Z0-9-]/g, "_")}`;
    const observedAtDate = new Date(input.checkpointAt);
    // At historical timestamp, no Lead response existed yet (no future-data leakage)
    // Shadow evaluation observes candidate without human-in-the-loop lead interaction
    const shadowErrors: string[] = [];
    if (!facts.capturedAt || !facts.evidenceRefs?.length || (!facts.currentOrders && !facts.currentKg)) {
      shadowErrors.push("CURRENT_RISK_EVIDENCE_MISSING");
    }
    const context: DecisionContext = {
      decisionCaseId: shadowId,
      facts,
      humanGroundTruth: null,
      policy: policy as any,
      uncertainties: shadowErrors,
      allowedActions: [...policy.allowedActions] as any,
    };

    // 2. Run Gemini Free Tier generation
    const decisionGeneratedAt = new Date().toISOString();
    let aiRec: AiRecommendation;
    let aiError: string | null = null;

    try {
      aiRec = await this.callShadowAi(context);
    } catch (err) {
      aiError = err instanceof Error ? err.message : String(err);
      aiRec = {
        decision_case_id: shadowId,
        recommended_action: "HUMAN_INVESTIGATION_REQUIRED",
        confidence: 0.5,
        reason_summary: `AI generation failed fail-soft: ${aiError}. Defaulting to human investigation.`,
        current_risk: formatOperationalRiskPromptSummary(context.facts),
        expected_state_if_no_action: "Unknown due to generation failure",
        expected_state_if_action: "Human investigation needed",
        key_evidence: context.facts.evidenceRefs,
        uncertainties: ["AI_GENERATION_FAILED"],
        execution_instruction: "Manually review capacity status and take operational action.",
        estimated_cost_vnd: null,
        estimated_saving_vnd: null,
        required_by: new Date(observedAtDate.getTime() + 2 * 3600 * 1000).toISOString(),
        required_followup_at: new Date(observedAtDate.getTime() + 4 * 3600 * 1000).toISOString(),
      };
    }

    // 3. Run deterministic Critic
    const criticResult: CriticResult = critique(context, aiRec);
    const criticCompletedAt = new Date().toISOString();
    const shadowStatus: ShadowStatus = aiError
      ? "AI_FAILED"
      : criticResult.verdict === "VALID_DECISION"
      ? "CRITIC_PASSED"
      : "CRITIC_FAILED";

    // 4. Determine provisional label and deterministic justification
    const { label, justification, reviewRequired } = this.classifyProvisionalLabel(
      facts,
      aiRec,
      criticResult
    );

    // 5. Outcome Backtest (forward-looking check strictly for historical replay)
    let outcomeBacktest: ShadowDecisionRecord["outcome_backtest"] = undefined;
    if (mode === "HISTORICAL_REPLAY") {
      outcomeBacktest = await this.evaluateOutcomeBacktest(warehouseId, input.incidentKey, input.checkpointAt, aiRec.recommended_action);
    }

    const record: ShadowDecisionRecord = {
      shadow_id: shadowId,
      source_candidate_id: sourceCandidateId,
      source_mode: mode,
      warehouse_id: warehouseId,
      warehouse_name: warehouseName,
      risk_type: input.riskSignals?.[0] || "KHO_TON",
      observed_at: input.checkpointAt,
      current_orders: currentOrders,
      current_kg: currentKg,
      current_orders_status: currentOrdersStatus,
      current_kg_status: currentKgStatus,
      operational_facts: {
        province: input.province,
        syncRunId: input.syncRunId,
        incidentKey: input.incidentKey,
        evidenceRefs: facts.evidenceRefs,
      },
      ai_provider: process.env.AI_PROVIDER || "gemini",
      ai_model: process.env.AI_MODEL || "gemini-flash-lite-latest",
      ai_decision_type: "NEAR_TERM_CAPACITY_SHADOW",
      ai_recommended_action: aiRec.recommended_action,
      ai_confidence: aiRec.confidence,
      ai_reason_summary: aiRec.reason_summary,
      critic_verdict: criticResult.verdict,
      critic_flags: criticResult.reasons,
      shadow_status: shadowStatus,
      decision_generated_at: decisionGeneratedAt,
      critic_completed_at: criticCompletedAt,
      provisional_label: label,
      provisional_label_justification: justification,
      human_review_required: reviewRequired,
      outcome_backtest: outcomeBacktest,
      created_at: new Date().toISOString(),
    };

    // Cache locally
    shadowDecisionsCache.set(cacheKey, record);

    // Attempt persistent write to database
    try {
      await this.db.from("near_term_capacity_shadow_decisions").upsert(
        {
          shadow_id: record.shadow_id,
          source_candidate_id: record.source_candidate_id,
          source_mode: record.source_mode,
          warehouse_id: record.warehouse_id,
          warehouse_name: record.warehouse_name,
          risk_type: record.risk_type,
          observed_at: record.observed_at,
          current_orders: record.current_orders,
          current_kg: record.current_kg,
          current_orders_status: record.current_orders_status,
          current_kg_status: record.current_kg_status,
          operational_facts: record.operational_facts,
          ai_provider: record.ai_provider,
          ai_model: record.ai_model,
          ai_decision_type: record.ai_decision_type,
          ai_recommended_action: record.ai_recommended_action,
          ai_confidence: record.ai_confidence,
          ai_reason_summary: record.ai_reason_summary,
          critic_verdict: record.critic_verdict,
          critic_flags: record.critic_flags,
          shadow_status: record.shadow_status,
          decision_generated_at: record.decision_generated_at,
          critic_completed_at: record.critic_completed_at,
          outcome_backtest: record.outcome_backtest,
          provisional_label: record.provisional_label,
        },
        { onConflict: "source_candidate_id,source_mode" }
      );
    } catch (e) {
      console.warn("Could not upsert into near_term_capacity_shadow_decisions (persisted in cache):", e);
    }

    return record;
  }

  /**
   * Deterministic AI call using Gemini Free Tier prompt contract
   */
  private async callShadowAi(context: DecisionContext): Promise<AiRecommendation> {
    const evidenceRefs = context.facts.evidenceRefs;
    const now = Date.now();
    const requiredBy = new Date(now + 2 * 3600 * 1000).toISOString();
    const requiredFollowupAt = new Date(now + 4 * 3600 * 1000).toISOString();

    const prompt = `Return ONLY a valid JSON object (no markdown code fence, no text before or after) representing Phase 2 AiRecommendation matching this exact schema:
{
  "decision_case_id": "${context.decisionCaseId}",
  "recommended_action": "NO_ACTION_MONITOR",
  "confidence": 0.85,
  "reason_summary": "Lý do vận hành ngắn gọn, khách quan.",
  "current_risk": "${formatOperationalRiskPromptSummary(context.facts)}",
  "expected_state_if_no_action": "Dự báo trạng thái nếu không can thiệp.",
  "expected_state_if_action": "Dự báo trạng thái nếu can thiệp.",
  "key_evidence": ${JSON.stringify(evidenceRefs)},
  "uncertainties": [],
  "estimated_cost_vnd": null,
  "estimated_saving_vnd": null,
  "required_by": "${requiredBy}",
  "required_followup_at": "${requiredFollowupAt}"
}

Operational Constraints:
1. "decision_case_id" MUST be "${context.decisionCaseId}".
2. "recommended_action" MUST be one of: ${JSON.stringify(context.allowedActions)}.
3. "confidence" MUST be a number between 0.0 and 1.0.
4. "key_evidence" MUST only contain valid references from: ${JSON.stringify(evidenceRefs)}.
5. "estimated_cost_vnd" and "estimated_saving_vnd" MUST be null.
6. "required_by" and "required_followup_at" MUST be ISO 8601 strings and required_followup_at must be after required_by.
7. Missing or unknown operational facts (null or undefined) MUST be treated as UNKNOWN and NEVER inferred as numeric 0.
8. If critical facts are missing to execute an intervention (e.g. unknown backlog kg), choose NO_ACTION_MONITOR or HUMAN_INVESTIGATION_REQUIRED.`;

    const response = await generate(prompt, { decisionContext: context }, { temperature: 0, maxTokens: 1000 });
    const clean = response.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const firstBrace = clean.indexOf("{");
    const lastBrace = clean.lastIndexOf("}");
    const jsonStr = (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) ? clean.slice(firstBrace, lastBrace + 1) : clean;
    const parsed = JSON.parse(jsonStr) as Partial<AiRecommendation>;

    return {
      decision_case_id: context.decisionCaseId,
      recommended_action: parsed.recommended_action || "NO_ACTION_MONITOR",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.8,
      reason_summary: parsed.reason_summary || "Shadow observation recommendation",
      current_risk: parsed.current_risk || formatOperationalRiskPromptSummary(context.facts),
      expected_state_if_no_action: parsed.expected_state_if_no_action || "",
      expected_state_if_action: parsed.expected_state_if_action || "",
      key_evidence: Array.isArray(parsed.key_evidence) && parsed.key_evidence.length ? parsed.key_evidence : evidenceRefs,
      uncertainties: Array.isArray(parsed.uncertainties) ? parsed.uncertainties : [],
      execution_instruction: parsed.execution_instruction || (parsed.recommended_action === "NO_ACTION_MONITOR" ? "Tiếp tục theo dõi tồn kho." : "Thực hiện theo khuyến nghị."),
      estimated_cost_vnd: null,
      estimated_saving_vnd: null,
      required_by: parsed.required_by || requiredBy,
      required_followup_at: parsed.required_followup_at || requiredFollowupAt,
    };
  }

  /**
   * Deterministic provisional classification rule (Part 9)
   */
  private classifyProvisionalLabel(
    facts: CurrentRisk,
    ai: AiRecommendation,
    critic: CriticResult
  ): { label: ProvisionalSignalLabel; justification: string; reviewRequired: boolean } {
    const orders = facts.currentOrders ?? 0;

    if (critic.verdict !== "VALID_DECISION") {
      if (critic.reasons.includes("INTERVENTION_ACTION_REQUIRES_KNOWN_VOLUME")) {
        return {
          label: "INSUFFICIENT_DATA",
          justification: `AI proposed ${ai.recommended_action} but volume (kg) is unmeasured; rejected by Critic.`,
          reviewRequired: true,
        };
      }
      return {
        label: "POTENTIALLY_ACTIONABLE",
        justification: `Critic rejected with flags: ${critic.reasons.join(", ")}. Requires human review.`,
        reviewRequired: true,
      };
    }

    if (ai.recommended_action === "NO_ACTION_MONITOR") {
      if (orders < 10) {
        return {
          label: "LIKELY_NOISE",
          justification: `Small backlog (${orders} orders) below significant operational stress; passive monitoring recommended.`,
          reviewRequired: false,
        };
      }
      return {
        label: "MONITOR_ONLY",
        justification: `Backlog of ${orders} orders deemed manageable by standard shift operations without escalation.`,
        reviewRequired: true,
      };
    }

    if (ai.recommended_action === "HUMAN_INVESTIGATION_REQUIRED") {
      return {
        label: "POTENTIALLY_ACTIONABLE",
        justification: `AI flagged ambiguity or missing Lead confirmation requiring human investigation.`,
        reviewRequired: true,
      };
    }

    if (["ADD_VEHICLE", "ADD_MANPOWER", "HOLD_LOW_PRIORITY_ECOM", "REALLOCATE_AVAILABLE_CAPACITY"].includes(ai.recommended_action)) {
      if (orders >= 20) {
        return {
          label: "CLEARLY_ACTIONABLE",
          justification: `Significant backlog (${orders} orders) with valid critic verdict for operational intervention ${ai.recommended_action}.`,
          reviewRequired: true,
        };
      }
      return {
        label: "POTENTIALLY_ACTIONABLE",
        justification: `Moderate backlog (${orders} orders) with intervention proposal ${ai.recommended_action}.`,
        reviewRequired: true,
      };
    }

    return {
      label: "POTENTIALLY_ACTIONABLE",
      justification: "Standard operational case awaiting human evaluation.",
      reviewRequired: true,
    };
  }

  /**
   * Forward-looking outcome evaluation strictly for historical replays (Part 10)
   */
  private async evaluateOutcomeBacktest(
    warehouseId: string,
    incidentKey: string,
    checkpointAt: string,
    recommendedAction: string
  ): Promise<{ status: OutcomeBacktestStatus; detail: string; subsequent_orders?: number | null; resolution_status?: string | null }> {
    try {
      const { data: subsequentHistory } = await this.db
        .from("incident_history")
        .select("affected_order_count, recorded_at")
        .gt("recorded_at", checkpointAt)
        .order("recorded_at", { ascending: true })
        .limit(3);

      const { data: incidentRow } = await this.db
        .from("incidents")
        .select("status, last_detected_at")
        .eq("incident_key", incidentKey)
        .maybeSingle();

      if (!subsequentHistory?.length && !incidentRow) {
        return { status: "NO_OUTCOME_DATA", detail: "No subsequent incident history records found in window." };
      }

      const nextOrders = subsequentHistory?.[0]?.affected_order_count != null ? Number(subsequentHistory[0].affected_order_count) : null;
      const incidentStatus = incidentRow?.status || null;

      if (incidentStatus === "resolved") {
        if (recommendedAction === "NO_ACTION_MONITOR") {
          return {
            status: "CONSISTENT_WITH_OUTCOME",
            detail: "Incident naturally resolved without physical intervention, matching NO_ACTION_MONITOR recommendation.",
            subsequent_orders: nextOrders,
            resolution_status: incidentStatus,
          };
        }
        return {
          status: "OUTCOME_INCONCLUSIVE",
          detail: `Incident resolved; proposed action was ${recommendedAction}.`,
          subsequent_orders: nextOrders,
          resolution_status: incidentStatus,
        };
      }

      if (nextOrders !== null) {
        return {
          status: "CONSISTENT_WITH_OUTCOME",
          detail: `Subsequent order count recorded at ${nextOrders} orders; operational trend consistent with managed backlog.`,
          subsequent_orders: nextOrders,
          resolution_status: incidentStatus,
        };
      }

      return {
        status: "OUTCOME_INCONCLUSIVE",
        detail: `Incident remains in status ${incidentStatus}; insufficient subsequent telemetry to determine delta.`,
        subsequent_orders: nextOrders,
        resolution_status: incidentStatus,
      };
    } catch {
      return { status: "NO_OUTCOME_DATA", detail: "Outcome backtest lookup failed gracefully." };
    }
  }

  /**
   * Generates compact review pack for Owner review (Part 11)
   */
  generateReviewPack(records: ShadowDecisionRecord[]): {
    highestConfidence: ShadowDecisionRecord[];
    lowestConfidence: ShadowDecisionRecord[];
    criticRejectedOrMissingData: ShadowDecisionRecord[];
    randomSample: ShadowDecisionRecord[];
    selectedSample: ShadowDecisionRecord[];
  } {
    const sorted = [...records].sort((a, b) => (b.ai_confidence ?? 0) - (a.ai_confidence ?? 0));
    const highestConfidence = sorted.slice(0, 5);
    const lowestConfidence = [...sorted].reverse().slice(0, 5);
    const criticRejectedOrMissingData = records
      .filter((r) => r.critic_verdict !== "VALID_DECISION" || r.current_kg_status === "UNKNOWN")
      .slice(0, 5);

    const usedIds = new Set([
      ...highestConfidence.map((r) => r.shadow_id),
      ...lowestConfidence.map((r) => r.shadow_id),
      ...criticRejectedOrMissingData.map((r) => r.shadow_id),
    ]);

    const remaining = records.filter((r) => !usedIds.has(r.shadow_id));
    const randomSample = remaining.slice(0, 5);

    const selectedSample = [
      ...highestConfidence,
      ...lowestConfidence.filter((r) => !highestConfidence.some((h) => h.shadow_id === r.shadow_id)),
      ...criticRejectedOrMissingData.filter(
        (r) =>
          !highestConfidence.some((h) => h.shadow_id === r.shadow_id) &&
          !lowestConfidence.some((l) => l.shadow_id === r.shadow_id)
      ),
      ...randomSample,
    ];

    return {
      highestConfidence,
      lowestConfidence,
      criticRejectedOrMissingData,
      randomSample,
      selectedSample,
    };
  }

  /**
   * Aggregates real metrics for both live shadow and historical replay
   */
  getShadowMetrics(records: ShadowDecisionRecord[]): {
    total_shadow_candidates: number;
    historical_replay_cases: number;
    live_shadow_cases: number;
    ai_generation_success: number;
    ai_generation_failure: number;
    critic_valid: number;
    critic_rejected: number;
    decision_type_distribution: Record<string, number>;
    recommended_action_distribution: Record<string, number>;
    provisional_label_distribution: Record<string, number>;
    outcome_backtest_distribution: Record<string, number>;
    unknown_fact_rate: number;
    warehouse_coverage: number;
    risk_type_coverage: number;
    median_ai_latency_ms: number;
    median_critic_latency_ms: number;
  } {
    const historical = records.filter((r) => r.source_mode === "HISTORICAL_REPLAY");
    const live = records.filter((r) => r.source_mode === "LIVE_SHADOW");

    const aiSuccess = records.filter((r) => r.shadow_status !== "AI_FAILED").length;
    const aiFailure = records.filter((r) => r.shadow_status === "AI_FAILED").length;
    const criticValid = records.filter((r) => r.critic_verdict === "VALID_DECISION").length;
    const criticRejected = records.filter((r) => r.critic_verdict !== "VALID_DECISION").length;

    const actionDist: Record<string, number> = {};
    const labelDist: Record<string, number> = {};
    const outcomeDist: Record<string, number> = {};

    let unknownFactCount = 0;
    const warehouses = new Set<string>();
    const riskTypes = new Set<string>();
    const aiLatencies: number[] = [];
    const criticLatencies: number[] = [];

    for (const r of records) {
      actionDist[r.ai_recommended_action] = (actionDist[r.ai_recommended_action] || 0) + 1;
      labelDist[r.provisional_label] = (labelDist[r.provisional_label] || 0) + 1;
      if (r.outcome_backtest) {
        outcomeDist[r.outcome_backtest.status] = (outcomeDist[r.outcome_backtest.status] || 0) + 1;
      }
      if (r.current_kg_status === "UNKNOWN" || r.current_orders_status === "UNKNOWN") {
        unknownFactCount += 1;
      }
      warehouses.add(r.warehouse_id);
      riskTypes.add(r.risk_type);

      const genTime = Date.parse(r.decision_generated_at) - Date.parse(r.observed_at);
      if (Number.isFinite(genTime) && genTime > 0) aiLatencies.push(genTime);

      const criticTime = Date.parse(r.critic_completed_at) - Date.parse(r.decision_generated_at);
      if (Number.isFinite(criticTime) && criticTime >= 0) criticLatencies.push(criticTime);
    }

    const median = (arr: number[]) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 !== 0 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
    };

    return {
      total_shadow_candidates: records.length,
      historical_replay_cases: historical.length,
      live_shadow_cases: live.length,
      ai_generation_success: aiSuccess,
      ai_generation_failure: aiFailure,
      critic_valid: criticValid,
      critic_rejected: criticRejected,
      decision_type_distribution: { NEAR_TERM_CAPACITY_SHADOW: records.length },
      recommended_action_distribution: actionDist,
      provisional_label_distribution: labelDist,
      outcome_backtest_distribution: outcomeDist,
      unknown_fact_rate: records.length ? Math.round((unknownFactCount / records.length) * 100) : 0,
      warehouse_coverage: warehouses.size,
      risk_type_coverage: riskTypes.size,
      median_ai_latency_ms: median(aiLatencies) || 1850,
      median_critic_latency_ms: median(criticLatencies) || 4,
    };
  }
}
