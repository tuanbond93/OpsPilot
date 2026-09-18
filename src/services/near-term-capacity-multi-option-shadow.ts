import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/observability/logger";
import type { CurrentRisk, LeadFact, MultiOptionDecisionResult } from "@/domain/near-term-capacity";
import { runMultiOptionEvaluation, GovernedVehicleSourceAdapter } from "@/domain/near-term-capacity";

export function isMultiOptionShadowEnabled(): boolean {
  return process.env.NEAR_TERM_CAPACITY_MULTI_OPTION_SHADOW_ENABLED === "true";
}

export class NearTermCapacityMultiOptionShadowService {
  constructor(private readonly db: SupabaseClient) {}

  /**
   * Executes multi-option evaluation strictly as shadow observation.
   *
   * GUARANTEES:
   * - Never overwrites near_term_capacity_cases.ai_recommendation
   * - Never sends Telegram messages or alerts
   * - Never generates operational work orders
   * - Never mutates case status or active flag
   */
  async evaluateShadow(
    caseId: string,
    facts: CurrentRisk,
    lead: LeadFact | null
  ): Promise<MultiOptionDecisionResult | null> {
    if (!isMultiOptionShadowEnabled()) {
      return null;
    }

    try {
      const vehicleSourceAdapter = new GovernedVehicleSourceAdapter({ db: this.db });
      const result = await runMultiOptionEvaluation(facts, lead, {
        caseId,
        vehicleSourceAdapter,
      });

      // Persist strictly as an observation event in near_term_capacity_events
      const eventPayload = {
        root_cause: result.root_cause,
        recommended_option: result.recommended_option,
        recommendation_reason: result.recommendation_reason,
        recommendation_summary: result.recommendation_reason,
        tradeoff_summary: result.tradeoff_summary,
        confidence: result.confidence,
        candidate_options: result.candidate_options,
        matrix_rows: result.matrix.rows,
        critic_verdict: result.critic_verdict,
        critic_flags: result.critic_flags,
        missing_data: result.missing_data,
        requested_information: result.requested_information,
      };

      const insertQuery = this.db.from("near_term_capacity_events").insert({
        case_id: caseId,
        event_type: "MULTI_OPTION_SHADOW_EVALUATED",
        actor: "shadow_engine:gate_3a",
        payload: eventPayload,
      });

      let insertedEvent: { id?: string; created_at?: string } | null = null;
      if (typeof (insertQuery as any)?.select === "function") {
        const { data } = await (insertQuery as any).select("id, created_at").maybeSingle();
        insertedEvent = data;
      } else {
        await insertQuery;
      }

      return {
        ...result,
        persistedEventId: insertedEvent?.id,
        generatedAt: insertedEvent?.created_at,
      };
    } catch (error) {
      logger.warn("Multi-option shadow evaluation failed (fail-soft)", {
        caseId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
