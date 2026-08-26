export interface EvaluationDifference {
  field: string;
  expected: any;
  actual: any;
  message: string;
}

export interface EvaluationScoreResult {
  score: number;
  passed: boolean;
  differences: EvaluationDifference[];
}

/**
 * Calculates evidence code match score (0 to 100)
 */
export function calculateEvidenceMatchScore(expected: string[], actual: string[]): { score: number; differences: EvaluationDifference[] } {
  const differences: EvaluationDifference[] = [];
  if (!expected || expected.length === 0) {
    return { score: 100, differences };
  }

  const actualSet = new Set(actual || []);
  const matched = expected.filter((code) => actualSet.has(code));
  const missing = expected.filter((code) => !actualSet.has(code));

  if (missing.length > 0) {
    differences.push({
      field: "evidenceCodes",
      expected,
      actual,
      message: `Missing expected evidence codes: ${missing.join(", ")}`,
    });
  }

  const score = Math.round((matched.length / expected.length) * 100);
  return { score, differences };
}

/**
 * Calculates score for string array inclusions (e.g. recommendation types or roles)
 */
export function calculateSetInclusionScore(
  fieldName: string,
  expected: string[],
  actual: string[]
): { score: number; differences: EvaluationDifference[] } {
  const differences: EvaluationDifference[] = [];
  if (!expected || expected.length === 0) {
    return { score: 100, differences };
  }

  const actualSet = new Set(actual || []);
  const matched = expected.filter((item) => actualSet.has(item));
  const missing = expected.filter((item) => !actualSet.has(item));

  if (missing.length > 0) {
    differences.push({
      field: fieldName,
      expected,
      actual,
      message: `Missing expected ${fieldName}: ${missing.join(", ")}`,
    });
  }

  const score = Math.round((matched.length / expected.length) * 100);
  return { score, differences };
}

/**
 * Checks numeric tolerance score
 */
export function calculateToleranceScore(
  fieldName: string,
  expected: number,
  actual: number,
  tolerance: number
): { score: number; differences: EvaluationDifference[] } {
  const differences: EvaluationDifference[] = [];
  const delta = Math.abs(expected - actual);

  if (delta <= tolerance) {
    return { score: 100, differences };
  }

  differences.push({
    field: fieldName,
    expected: `${expected} ± ${tolerance}`,
    actual,
    message: `${fieldName} value ${actual} exceeded tolerance window (${expected} ± ${tolerance})`,
  });

  const excess = delta - tolerance;
  const score = Math.max(0, Math.round(100 - excess * 2));
  return { score, differences };
}
