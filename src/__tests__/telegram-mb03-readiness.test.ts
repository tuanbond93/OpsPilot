import { describe, expect, it } from "vitest";
import { buildMb03ReadinessSnapshot } from "../services/telegram-mb03-readiness";

const state = (overrides: Record<string, unknown> = {}) => ({
  type: "MB03_DISCOVERY", caseId: "MB03-20260831-0900", status: "AWAITING_OUTCOME",
  warehouseName: "Kho MB03", updatedAt: "2026-08-31T09:00:00.000Z", outcomeDueAt: "2026-08-31T10:00:00.000Z", ...overrides,
});

describe("MB03 Telegram readiness snapshot", () => {
  it("uses only the newest immutable event for each case", () => {
    const result = buildMb03ReadinessSnapshot([
      { created_at: "2026-08-31T09:00:00.000Z", ai_result: state({ status: "ACTIVE", updatedAt: "2026-08-31T09:00:00.000Z" }) },
      { created_at: "2026-08-31T11:00:00.000Z", ai_result: state({ status: "COMPLETED", updatedAt: "2026-08-31T11:00:00.000Z" }) },
    ], new Date("2026-08-31T12:00:00.000Z"));

    expect(result).toMatchObject({ totalCases: 1, active: 0, completed: 1, overdueOutcome: 0 });
  });

  it("counts only due awaiting cases as overdue", () => {
    const result = buildMb03ReadinessSnapshot([
      { created_at: "2026-08-31T09:00:00.000Z", ai_result: state() },
      { created_at: "2026-08-31T09:00:00.000Z", ai_result: state({ caseId: "MB03-20260831-0901", outcomeDueAt: "2026-08-31T13:00:00.000Z" }) },
    ], new Date("2026-08-31T12:00:00.000Z"));

    expect(result).toMatchObject({ totalCases: 2, awaitingOutcome: 2, overdueOutcome: 1 });
    expect(result.overdueCases.map((item) => item.caseId)).toEqual(["MB03-20260831-0900"]);
  });
});
