import type { RiskResult } from "./risk-calculator";
import type { EvidenceCode } from "./evidence-builder";
import type { DeterministicContext } from "./context-builder";

export interface RootCauseCauseItem {
  title: string;
  confidence: number;
  evidenceCodes: string[];
  explanation: string;
}

export interface InvestigationStepItem {
  priority: "high" | "medium" | "low";
  action: string;
  rationale: string;
  requiredData: string[];
}

export interface RootCauseResult {
  summary: string;

  assessment: {
    status: "improving" | "stagnant" | "worsening" | "insufficient_data";
    explanation: string;
  };

  causes: RootCauseCauseItem[];

  investigationSteps: InvestigationStepItem[];

  risk: {
    score: number;
    level: "low" | "medium" | "high" | "critical";
    factors: Array<{
      code: string;
      label: string;
      contribution: number;
      evidence: string;
    }>;
  };

  confidence: number;

  limitations: string[];
}

/**
 * Sanitizes investigation step action strings to prevent operational commands
 */
function sanitizeInvestigationAction(action: string): string {
  const trimmed = action.trim();

  // Replace disallowed operational commands with safe investigation steps
  if (/^(dispatch|send|allocate|move|order)\s+/i.test(trimmed)) {
    return `Kiểm tra và xác minh kế hoạch điều phối: ${trimmed}`;
  }
  if (/bớt\s+\d+|giảm\s+\d+%/i.test(trimmed)) {
    return `Theo dõi tiến độ xử lý hàng tồn kho để đánh giá mức độ giảm tải.`;
  }

  return trimmed;
}

/**
 * Creates a safe fallback RootCauseResult when AI output is malformed or offline
 */
export function createFallbackResult(
  context: DeterministicContext,
  deterministicRisk: RiskResult,
  reason: string = "Dynamic explanation unavailable"
): RootCauseResult {
  let assessmentStatus: "improving" | "stagnant" | "worsening" | "insufficient_data" = "insufficient_data";

  if (context.historyPointCount >= 2) {
    if (context.trendDirection === "decreasing") assessmentStatus = "improving";
    else if (context.trendDirection === "increasing") assessmentStatus = "worsening";
    else assessmentStatus = "stagnant";
  }

  return {
    summary: `Đánh giá vận hành tại ${context.warehouseName}: Sự cố ${context.reasonName} đang ảnh hưởng ${context.currentAffectedCount} đơn hàng. (${reason})`,
    assessment: {
      status: assessmentStatus,
      explanation: `Sự cố hiện có ${context.currentAffectedCount} đơn hàng bị ảnh hưởng. ${
        context.historyPointCount >= 2
          ? `So với kỳ trước (${context.previousAffectedCount} đơn), số lượng đã thay đổi ${context.changePercent}%.`
          : "Chưa đủ lịch sử để đánh giá xu hướng."
      }`,
    },
    causes: [
      {
        title: `Tồn đọng vận hành: ${context.reasonName}`,
        confidence: 85,
        evidenceCodes: ["CURRENT_AFFECTED_COUNT", "MAXIMUM_AGE_HOURS"],
        explanation: `Đơn hàng tồn đọng tại ${context.warehouseName} vượt quá ngưỡng SLA quy định (${context.maximumAgeHours || 0}h).`,
      },
    ],
    investigationSteps: [
      {
        priority: context.currentAffectedCount > 50 ? "high" : "medium",
        action: `Kiểm tra tình trạng phân công nhân sự và ca trực tại ${context.warehouseName}.`,
        rationale: "Xác minh xem nhân sự ca hiện tại có đủ năng lực xử lý lượng đơn tồn đọng hay không.",
        requiredData: ["Mã đơn hàng", "Danh sách ca trực kho"],
      },
      {
        priority: "medium",
        action: `Rà soát các đơn hàng tồn đọng quá 24h (Đơn lâu nhất: ${context.oldestOrderCode || "N/A"}).`,
        rationale: "Ưu tiên làm rõ nguyên nhân đơn chưa di chuyển.",
        requiredData: ["Mã đơn hàng", "Lịch sử quét mã kho"],
      },
    ],
    risk: {
      score: deterministicRisk.score,
      level: deterministicRisk.level,
      factors: deterministicRisk.factors,
    },
    confidence: 85,
    limitations: [
      "Không có dữ liệu nhân sự / ca trực kho trong hệ thống.",
      "Không có dữ liệu về phương tiện và tài xế vận chuyển.",
      "Chưa tích hợp dữ liệu hẹn giao từ dịch vụ khách hàng (CS).",
    ],
  };
}

/**
 * Parses and strictly validates AI response text against evidence codes and deterministic risk
 */
export function parseRootCauseResult(
  rawText: string,
  deterministicRisk: RiskResult,
  validEvidenceCodes: Set<string>,
  context: DeterministicContext
): RootCauseResult {
  let cleanJsonText = rawText.trim();
  cleanJsonText = cleanJsonText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanJsonText);
  } catch {
    return createFallbackResult(context, deterministicRisk, "AI response was not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null) {
    return createFallbackResult(context, deterministicRisk, "AI response root is not an object");
  }

  const obj = parsed as Record<string, unknown>;

  // Summary
  const summary = typeof obj.summary === "string" && obj.summary.trim()
    ? obj.summary.trim()
    : `Đánh giá sự cố ${context.reasonName} tại ${context.warehouseName}.`;

  // Assessment
  const rawAssessment = (obj.assessment as Record<string, unknown>) || {};
  const validStatuses = ["improving", "stagnant", "worsening", "insufficient_data"];
  const assessmentStatus = validStatuses.includes(String(rawAssessment.status))
    ? (String(rawAssessment.status) as any)
    : context.historyPointCount < 2
    ? "insufficient_data"
    : context.trendDirection === "decreasing"
    ? "improving"
    : context.trendDirection === "increasing"
    ? "worsening"
    : "stagnant";

  const assessmentExplanation = typeof rawAssessment.explanation === "string"
    ? rawAssessment.explanation
    : `Sự cố hiện đang có ${context.currentAffectedCount} đơn hàng bị ảnh hưởng.`;

  // Causes (max 5)
  const rawCauses = Array.isArray(obj.causes) ? obj.causes : [];
  const causes: RootCauseCauseItem[] = rawCauses.slice(0, 5).map((c: any) => {
    const rawEvCodes = Array.isArray(c.evidenceCodes) ? c.evidenceCodes.map(String) : [];
    // Reject unknown evidence codes!
    const validatedEvCodes = rawEvCodes.filter((code: string) => validEvidenceCodes.has(code));

    return {
      title: String(c.title || "Nguyên nhân vận hành"),
      confidence: typeof c.confidence === "number" ? Math.min(Math.max(c.confidence, 0), 100) : 80,
      evidenceCodes: validatedEvCodes.length > 0 ? validatedEvCodes : ["CURRENT_AFFECTED_COUNT"],
      explanation: String(c.explanation || "Chưa có giải thích chi tiết."),
    };
  });

  // Investigation Steps (max 5)
  const rawSteps = Array.isArray(obj.investigationSteps) ? obj.investigationSteps : [];
  const investigationSteps: InvestigationStepItem[] = rawSteps.slice(0, 5).map((s: any) => {
    const rawPriority = String(s.priority || "medium").toLowerCase();
    const priority = ["high", "medium", "low"].includes(rawPriority)
      ? (rawPriority as "high" | "medium" | "low")
      : "medium";

    return {
      priority,
      action: sanitizeInvestigationAction(String(s.action || "Rà soát trạng thái đơn hàng")),
      rationale: String(s.rationale || "Xác minh tình trạng vận hành"),
      requiredData: Array.isArray(s.requiredData) ? s.requiredData.map(String) : ["Mã đơn hàng"],
    };
  });

  // Limitations (max 10)
  const rawLimitations = Array.isArray(obj.limitations) ? obj.limitations.map(String) : [];
  const defaultLimitations = [
    "Không có dữ liệu nhân sự / ca trực kho trong hệ thống.",
    "Không có dữ liệu về phương tiện và tài xế vận chuyển.",
  ];

  const combinedLimitations = Array.from(new Set([...rawLimitations, ...defaultLimitations])).slice(0, 10);

  const confidence = typeof obj.confidence === "number"
    ? Math.min(Math.max(obj.confidence, 0), 100)
    : 85;

  return {
    summary,
    assessment: {
      status: assessmentStatus,
      explanation: assessmentExplanation,
    },
    causes: causes.length > 0 ? causes : createFallbackResult(context, deterministicRisk).causes,
    investigationSteps:
      investigationSteps.length > 0
        ? investigationSteps
        : createFallbackResult(context, deterministicRisk).investigationSteps,
    risk: {
      score: deterministicRisk.score,
      level: deterministicRisk.level,
      factors: deterministicRisk.factors,
    },
    confidence,
    limitations: combinedLimitations,
  };
}
