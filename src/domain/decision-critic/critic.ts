import type { DecisionCriticInput, DecisionCriticReasonCode, DecisionCriticResult } from "./types";

function confidenceThreshold(riskSeverity?: string): number {
  if (riskSeverity === "critical") return 75;
  if (riskSeverity === "high") return 65;
  return 50;
}

export function critiqueFinalDecision(input: DecisionCriticInput): DecisionCriticResult {
  const decision = input.finalDecision;
  const option = decision.selectedOption;
  const threshold = confidenceThreshold(option?.riskSeverity);
  const checks = {
    selectedOptionPresent: Boolean(option),
    actionPresent: Boolean(option?.action?.trim()),
    rationalePresent: Boolean(option?.rationale?.trim()),
    evidencePresent: decision.evidenceRefs.length > 0,
    confidenceThreshold: threshold,
    confidenceSufficient: decision.confidence >= threshold,
    highRiskPrerequisitesResolved: !option
      || !["high", "critical"].includes(option.riskSeverity)
      || option.prerequisiteData.length === 0,
  };
  const reasonCodes: DecisionCriticReasonCode[] = [];

  if (decision.disposition !== "DECIDE") reasonCodes.push("UPSTREAM_ABSTAINED");
  if (!checks.selectedOptionPresent) reasonCodes.push("SELECTED_OPTION_MISSING");
  if (option && !checks.actionPresent) reasonCodes.push("ACTION_MISSING");
  if (option && !checks.rationalePresent) reasonCodes.push("RATIONALE_MISSING");
  if (option && !checks.evidencePresent) reasonCodes.push("EVIDENCE_MISSING");
  if (option && !checks.confidenceSufficient) reasonCodes.push("CONFIDENCE_BELOW_THRESHOLD");
  if (option && !checks.highRiskPrerequisitesResolved) reasonCodes.push("HIGH_RISK_PREREQUISITE_UNRESOLVED");

  const verdict = reasonCodes.length === 0 ? "PASS" : "HUMAN_INVESTIGATION_REQUIRED";
  const requiredData = [...new Set([
    ...(decision.humanInvestigation?.requiredData || []),
    ...(option?.prerequisiteData || []),
  ])].sort();

  return {
    verdict,
    reasonCodes,
    reviewSummary: verdict === "PASS"
      ? `Decision passed LC-02 safety checks at confidence ${decision.confidence} (minimum ${threshold}).`
      : `Decision abstained because safety checks failed: ${reasonCodes.join(", ")}.`,
    checks,
    humanInvestigation: verdict === "PASS" ? null : {
      action: decision.humanInvestigation?.action || "Verify the missing evidence and prerequisites before operational approval.",
      rationale: decision.humanInvestigation?.rationale || "The independent critic did not find the final decision safe enough to present for approval.",
      requiredData,
    },
    provenance: {
      critic: "DETERMINISTIC_DECISION_CRITIC",
      version: "lc02-v1",
      reviewedDecisionVersion: decision.provenance.version,
      reviewedAt: input.reviewedAt || new Date().toISOString(),
    },
  };
}
