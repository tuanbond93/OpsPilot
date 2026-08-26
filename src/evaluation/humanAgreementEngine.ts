// src/evaluation/humanAgreementEngine.ts

export interface DetailedAgreementScores {
  executiveSummaryAgreement: number; // 0-100
  rootCauseAgreement: number;        // 0-100
  evidenceAgreement: number;         // 0-100
  recommendationsAgreement: number;  // 0-100
  businessImpactAgreement: number;   // 0-100
  escalationAgreement: number;       // 0-100
  riskAssessmentAgreement: number;   // 0-100
  confidenceAgreement: number;       // 0-100
  overallAgreement: number;          // 0-100 (unweighted mean)
  weightedAgreement: number;         // 0-100 (weighted sum)
}

/**
 * Calculates human agreement scores comparing original AI output against human approved output.
 */
export function calculateHumanAgreement(
  originalResult: Record<string, unknown>,
  approvedResult: Record<string, unknown> | null,
  reviewStatus: "APPROVED" | "EDITED" | "REJECTED" | "PENDING" | "SUPERSEDED"
): DetailedAgreementScores {
  if (reviewStatus === "REJECTED" || !approvedResult) {
    return {
      executiveSummaryAgreement: 0,
      rootCauseAgreement: 0,
      evidenceAgreement: 0,
      recommendationsAgreement: 0,
      businessImpactAgreement: 0,
      escalationAgreement: 0,
      riskAssessmentAgreement: 0,
      confidenceAgreement: 0,
      overallAgreement: 0,
      weightedAgreement: 0,
    };
  }

  if (reviewStatus === "APPROVED") {
    return {
      executiveSummaryAgreement: 100,
      rootCauseAgreement: 100,
      evidenceAgreement: 100,
      recommendationsAgreement: 100,
      businessImpactAgreement: 100,
      escalationAgreement: 100,
      riskAssessmentAgreement: 100,
      confidenceAgreement: 100,
      overallAgreement: 100,
      weightedAgreement: 100,
    };
  }

  const origAny = originalResult as any;
  const apprAny = approvedResult as any;

  // Review status is EDITED: compare fields between original and edited
  const execSummaryScore = compareTextSimilarity(
    String(origAny?.summary?.description || origAny?.executiveSummary || ""),
    String(apprAny?.summary?.description || apprAny?.executiveSummary || "")
  );

  const rootCauseScore = compareTextSimilarity(
    String(origAny?.summary?.rootCause || origAny?.rootCause || ""),
    String(apprAny?.summary?.rootCause || apprAny?.rootCause || "")
  );

  const evidenceScore = compareArraySimilarity(
    origAny?.evidence?.rootCauseEvidence || origAny?.evidence || [],
    apprAny?.evidence?.rootCauseEvidence || apprAny?.evidence || []
  );

  const recsScore = compareArraySimilarity(
    origAny?.summary?.recommendedActions || origAny?.recommendations || [],
    apprAny?.summary?.recommendedActions || apprAny?.recommendations || []
  );

  const impactScore = compareObjectSimilarity(
    origAny?.impact || {},
    apprAny?.impact || {}
  );

  const escalationScore = compareObjectSimilarity(
    origAny?.escalation || {},
    apprAny?.escalation || {}
  );

  const riskScore = compareObjectSimilarity(
    origAny?.risk || {},
    apprAny?.risk || {}
  );

  const origConf = typeof origAny?.confidence === "number" ? origAny.confidence : 1.0;
  const apprConf = typeof apprAny?.confidence === "number" ? apprAny.confidence : 1.0;
  const confidenceScore = Math.max(0, Math.round((1 - Math.abs(origConf - apprConf)) * 100));

  const overallAgreement = Math.round(
    (execSummaryScore +
      rootCauseScore +
      evidenceScore +
      recsScore +
      impactScore +
      escalationScore +
      riskScore +
      confidenceScore) /
      8
  );

  // Weights: Root Cause 20%, Recommendations 25%, Exec Summary 15%, Evidence 15%, Impact 10%, Escalation 5%, Risk 5%, Confidence 5%
  const weightedAgreement = Math.round(
    rootCauseScore * 0.20 +
      recsScore * 0.25 +
      execSummaryScore * 0.15 +
      evidenceScore * 0.15 +
      impactScore * 0.10 +
      escalationScore * 0.05 +
      riskScore * 0.05 +
      confidenceScore * 0.05
  );

  return {
    executiveSummaryAgreement: execSummaryScore,
    rootCauseAgreement: rootCauseScore,
    evidenceAgreement: evidenceScore,
    recommendationsAgreement: recsScore,
    businessImpactAgreement: impactScore,
    escalationAgreement: escalationScore,
    riskAssessmentAgreement: riskScore,
    confidenceAgreement: confidenceScore,
    overallAgreement,
    weightedAgreement,
  };
}

function compareTextSimilarity(a: string, b: string): number {
  if (!a && !b) return 100;
  if (!a || !b) return 0;
  if (a.trim() === b.trim()) return 100;

  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 100 : Math.round((intersection / union) * 100);
}

function compareArraySimilarity(arrA: any, arrB: any): number {
  if (!Array.isArray(arrA) || !Array.isArray(arrB)) return 50;
  if (arrA.length === 0 && arrB.length === 0) return 100;
  if (arrA.length === 0 || arrB.length === 0) return 0;

  const setA = new Set(arrA.map((x) => String(x).toLowerCase().trim()));
  const setB = new Set(arrB.map((x) => String(x).toLowerCase().trim()));
  let match = 0;
  for (const item of setA) {
    if (setB.has(item)) match++;
  }
  const total = new Set([...setA, ...setB]).size;
  return total === 0 ? 100 : Math.round((match / total) * 100);
}

function compareObjectSimilarity(objA: any, objB: any): number {
  if (typeof objA !== "object" || typeof objB !== "object" || !objA || !objB) return 50;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length === 0 && keysB.length === 0) return 100;

  let matches = 0;
  const allKeys = new Set([...keysA, ...keysB]);
  for (const k of allKeys) {
    if (String(objA[k]) === String(objB[k])) matches++;
  }
  return allKeys.size === 0 ? 100 : Math.round((matches / allKeys.size) * 100);
}
