import { generate, loadPromptMetadata } from "../../ai";
import type { Incident } from "../../engine/incident";
import type { IncidentHistoryRow } from "../../connectors/supabase";
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
    promptVersion: number;
    generatedAt: string;
  };
}

export class RootCauseAgent {
  /**
   * Analyzes an operational incident using Event Store metrics & deterministic risk engine.
   * Explains evidence in operational language without issuing unauthorized operational commands.
   */
  async analyzeIncident(
    incident: Incident,
    historyRows: IncidentHistoryRow[] = [],
    options: { provider?: string; temperature?: number; model?: string } = {}
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
      promptMeta = { name: "rootcause", version: 2, language: "vi", content: "" };
    }

    const inputForAI = {
      incidentContext: context,
      verifiedEvidence: evidence,
      deterministicRisk: risk,
      allowedEvidenceCodes: Array.from(validEvidenceCodes),
    };

    const systemPrompt = `You are the Lead Logistics Operations Investigator for OpsPilot. Prompt Version: ${promptMeta.version}. Answer in Vietnamese using strictly the supplied evidence codes and deterministic risk. Return valid JSON only.`;

    let providerName = options.provider || process.env.AI_PROVIDER || "openai";
    let modelName = options.model || (providerName === "gemini" ? "gemini-1.5-flash" : "gpt-4o-mini");

    let analysis: RootCauseResult;

    try {
      const response = await generate("rootcause", inputForAI, {
        provider: providerName,
        temperature: options.temperature ?? 0.1,
        model: modelName,
        systemPrompt,
      });

      modelName = response.model || modelName;
      analysis = parseRootCauseResult(response.text, risk, validEvidenceCodes, context);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      analysis = createFallbackResult(context, risk, `AI explanation offline: ${errorMsg}`);
    }

    return {
      analysis,
      context,
      evidence,
      risk,
      metadata: {
        provider: providerName,
        model: modelName,
        promptVersion: promptMeta.version,
        generatedAt,
      },
    };
  }
}
