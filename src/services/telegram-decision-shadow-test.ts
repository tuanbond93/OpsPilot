import { randomUUID } from "crypto";
import type { CreateDecisionInput } from "@/domain/decision";
import { sourceFingerprint } from "@/services/decision-telegram-shadow";

/**
 * Creates an unmistakably synthetic input for exercising the manager Telegram
 * callback lane. It deliberately has no incident, order, or execution link.
 */
export function buildTelegramDecisionShadowTest(actor: string, now = new Date(), testRunId = randomUUID()): CreateDecisionInput {
  const capturedAt = now.toISOString();
  const source = { type: "TELEGRAM_SHADOW_TEST", testRunId, capturedAt, zone: "YBA" };
  return {
    sourceLinks: {
      sourceType: "TELEGRAM_SHADOW_TEST",
      sourceId: testRunId,
      triageRoute: "AI_DECISION_REQUIRED",
      criticVerdict: "PASS",
    },
    sourceFingerprint: sourceFingerprint(source),
    idempotencyKey: `telegram-shadow-test:${testRunId}`,
    problem: "[TEST ONLY] Xung đột phương án điều phối giả lập — Yên Bái",
    rootCause: "Dữ liệu mô phỏng để kiểm tra luồng phản hồi Manager; không liên kết đơn hàng hoặc incident vận hành.",
    recommendedAction: "Ghi nhận lựa chọn Manager trong chế độ shadow; không tạo work order và không thực thi hành động.",
    alternatives: ["Yêu cầu bổ sung bằng chứng", "Từ chối phương án mô phỏng"],
    evidence: {
      sourceIdentifiers: { testRunId, environment: "manager-telegram-shadow" },
      signalContext: { isTest: true, zone: "YBA", conflict: "SIMULATED_DO_VS_DONT" },
      rootCauseContext: { isTest: true, summary: "Synthetic test only" },
      actionContext: {
        isTest: true,
        disposition: "DECIDE",
        selectionRationale: "Bài test xác nhận Manager có thể phản hồi đúng topic và đúng phạm vi Yên Bái.",
        expectedOperationalOutcome: "Chỉ tạo audit phản hồi Telegram; không có điều phối, work order hoặc thay đổi đơn hàng.",
        evidenceRefs: ["TEST: no live incident", "TEST: no live order"],
        risksAndLimitations: ["Synthetic test data", "Shadow observation only"],
        manualApprovalRequired: true,
      },
      operationalFacts: { isTest: true, affectedOrderCount: 0, capturedFrom: "telegram-shadow-test", capturedAt },
      capturedAt,
    },
    confidence: 92,
    riskLevel: "LOW",
    mode: "SHADOW",
    decisionDeadline: null,
    actor,
  };
}
