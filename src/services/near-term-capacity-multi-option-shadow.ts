import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/observability/logger";
import type { CurrentRisk, LeadFact, MultiOptionDecisionResult } from "@/domain/near-term-capacity";
import { runMultiOptionEvaluation } from "@/domain/near-term-capacity";

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
      const result = await runMultiOptionEvaluation(facts, lead, { caseId });

      // Persist strictly as an observation event in near_term_capacity_events
      await this.db.from("near_term_capacity_events").insert({
        case_id: caseId,
        event_type: "MULTI_OPTION_SHADOW_EVALUATED",
        actor: "shadow_engine:gate_3a",
        payload: {
          root_cause: result.root_cause,
          recommended_option: result.recommended_option,
          confidence: result.confidence,
          matrix_rows: result.matrix.rows,
          critic_verdict: result.critic_verdict,
          critic_flags: result.critic_flags,
          missing_data: result.missing_data,
        },
      });

      return result;
    } catch (error) {
      logger.warn("Multi-option shadow evaluation failed (fail-soft)", {
        caseId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
