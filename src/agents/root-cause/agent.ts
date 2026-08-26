import createHash from "crypto";
import { generate, loadPromptMetadata } from "../../ai";
import type { Incident } from "../../engine/incident";
import type { IncidentHistoryRow } from "@/connectors/supabase";
import { BoundedCache, ROOT_CAUSE_CACHE_MAX_ENTRIES } from "./bounded-cache";

import { buildRootCauseContext, type DeterministicContext } from "./context-builder";
import { buildDeterministicEvidence, type EvidenceItem } from "./evidence-builder";
import { calculateDeterministicRisk, type RiskResult } from "./risk-calculator";
import { parseRootCauseResult, createFallbackResult, type RootCauseResult } from "./schema";

export interface AgentAnalysisResponse {
  analysis: RootCauseResult;
  context: DeterministicContext;
  evidence: EvidenceItem[];
  risk: RiskResult;
  metadata: {
    provider: string;
    model: string;
    promptVersion: string;
    generatedAt: string;
  };
  cached?: boolean;
  contextHash?: string;
}

export class RootCauseAgent {
  private static cache = new BoundedCache<string, AgentAnalysisResponse>(ROOT_CAUSE_CACHE_MAX_ENTRIES);

  /**
   * Clears the in-memory cache for unit testing
   */
  static clearCache(): void {
    RootCauseAgent.cache.clear();
  }

  /**
   * Analyzes an operational incident using Event Store metrics & deterministic risk engine.
   * Became cache-aware in Sprint 6.5: returns cached result if identical context hash exists.
   */
  async analyzeIncident(
    incident: Incident,
    historyRows: IncidentHistoryRow[] = [],
    options: { provider?: string; temperature?: number; model?: string; forceRegenerate?: boolean } = {}
  ): Promise<AgentAnalysisResponse> {
    const referenceTimeMs = Date.now();
    const generatedAt = new Date(referenceTimeMs).toISOString();

    // 1. Build deterministic context metrics & trends
    const context = buildRootCauseContext(incident, historyRows, referenceTimeMs);

    // 2. Build deterministic evidence statements & codes
    const evidence = buildDeterministicEvidence(context);
    const validEvidenceCodes = new Set(evidence.map((e) => e.code));

    // 3. Calculate deterministic risk (AI cannot override risk)
    const risk = calculateDeterministicRisk(context);

    // 4. Load prompt template metadata
    let promptMeta;
    try {
      promptMeta = loadPromptMetadata("rootcause");
    } catch {
      promptMeta = { name: "rootcause", version: "v2", language: "vi", content: "" };
    }

    // 5. Compute canonical context hash
    const canonicalPayload = JSON.stringify({
      incidentId: incident.incidentId || incident.incidentKey,
      incidentKey: incident.incidentKey,
      reasonCode: incident.reasonCode,
      currentAffectedCount: context.currentAffectedCount,
      trendAssessment: context.trendAssessment,
      riskScore: risk.score,
      riskLevel: risk.level,
      evidenceCodes: Array.from(validEvidenceCodes).sort(),
      pickupJourneyCoveragePercent: context.pickupJourneyCoveragePercent,
      pickupDelayedOrderCount: context.pickupDelayedOrderCount,
      maximumPickupWaitHours: context.maximumPickupWaitHours,
      pickupDelayOrderCodes: [...context.pickupDelayOrderCodes].sort(),
      operationalPlaybookVersion: context.operationalPlaybookVersion,
      cpttSampleOrderCodes: [...context.cpttSampleOrderCodes].sort(),
      promptVersion: promptMeta.version,
    });
    const contextHash = createHash.createHash("sha256").update(canonicalPayload).digest("hex");

    // 6. Cache Check: Return cached response if context hash matches and forceRegenerate is false
    if (!options.forceRegenerate && RootCauseAgent.cache.has(contextHash)) {
      const cachedResult = RootCauseAgent.cache.get(contextHash)!;
      return {
        ...cachedResult,
        cached: true,
        contextHash,
      };
    }

    const inputForAI = {
      incidentContext: context,
      verifiedEvidence: evidence,
      deterministicRisk: risk,
      allowedEvidenceCodes: Array.from(validEvidenceCodes),
      operationalPlaybook: {
        version: context.operationalPlaybookVersion,
        cpttMeaning: "Mã đơn đuôi _CPTT là chứng từ thu hồi.",
        ghnMorningCotHour: context.ghnMorningCotHour,
        groupingPolicy: context.groupingPolicy,
        responsibilityRule: "Mỗi chặng tồn phải quy trách nhiệm cho kho đang giữ hàng hoặc kho nhập hàng muộn; không gộp nhiều lỗi chặng thành một nguyên nhân chung.",
      },
    };

    const systemPrompt = `You are the Lead Logistics Operations Investigator for OpsPilot. Prompt Version: ${promptMeta.version}. Answer in Vietnamese using strictly the supplied evidence codes and deterministic risk. Return valid JSON only.`;

    let response;
    const selectedProvider = options.provider || "openai";

    try {
      response = await generate("rootcause", inputForAI as Record<string, unknown>, {
        systemPrompt,
        temperature: options.temperature ?? 0.2,
        provider: selectedProvider,
        model: options.model,
      });
    } catch {
      const fallbackAnalysis = createFallbackResult(context, risk);
      const fallbackResult: AgentAnalysisResponse = {
        analysis: fallbackAnalysis,
        context,
        evidence,
        risk,
        metadata: {
          provider: "deterministic_fallback",
          model: "none",
          promptVersion: promptMeta.version,
          generatedAt,
        },
        cached: false,
        contextHash,
      };
      RootCauseAgent.cache.set(contextHash, fallbackResult);
      return fallbackResult;
    }

    const analysisResult = parseRootCauseResult(response.text, risk, validEvidenceCodes, context);

    const finalResult: AgentAnalysisResponse = {
      analysis: analysisResult,
      context,
      evidence,
      risk,
      metadata: {
        provider: selectedProvider,
        model: response.model,
        promptVersion: promptMeta.version,
        generatedAt,
      },
      cached: false,
      contextHash,
    };

    RootCauseAgent.cache.set(contextHash, finalResult);
    return finalResult;
  }
}
