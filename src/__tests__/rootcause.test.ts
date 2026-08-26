import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  RootCauseAgent,
  buildRootCauseContext,
  buildDeterministicEvidence,
  calculateDeterministicRisk,
  parseRootCauseResult,
  createFallbackResult,
} from "../agents/root-cause";
import { loadPromptMetadata } from "../ai";
import type { Incident } from "../engine/incident";
import type { IncidentHistoryRow } from "../connectors/supabase";
import * as aiModule from "../ai";
import fs from "fs";

describe("Sprint 4.2: Root Cause Agent Refactor & Evidence Grounding Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const dummyIncident: Incident = {
    incidentId: "inc-21160000-kho-ton",
    incidentKey: "21160000:KHO_TON",
    warehouseId: "21160000",
    warehouseName: "Kho Phú Thọ",
    reasonCode: "KHO_TON",
    reasonName: "Kho tồn",
    status: "open",
    priorityScore: 75,
    firstDetectedAt: "2026-08-05T00:00:00Z",
    lastDetectedAt: "2026-08-05T06:00:00Z",
    affectedOrderCount: 120,
    sampleOrderCodes: ["ORD-1", "ORD-2", "ORD-3", "ORD-4", "ORD-5"],
    averageAgeHours: 36.5,
    maximumAgeHours: 76.4,
    oldestOrderCode: "ORD-1",
  };

  function createHistoryRow(idStr: string, count: number, timeStr: string): IncidentHistoryRow {
    return {
      id: Number(idStr) || 1,
      incident_id: "inc-21160000-kho-ton",
      sync_run_id: `sync-${idStr}`,
      affected_order_count: count,
      sample_order_codes: ["ORD-1"],
      priority_score: 75,
      average_age_hours: 36.5,
      maximum_age_hours: 76.4,
      oldest_order_code: "ORD-1",
      recorded_at: timeStr,
    };
  }

  // 1. Evidence Builder uses exact Event Store values
  it("1. Evidence Builder uses exact Event Store values", () => {
    const context = buildRootCauseContext(dummyIncident, []);
    const evidence = buildDeterministicEvidence(context);

    const countEv = evidence.find((e) => e.code === "CURRENT_AFFECTED_COUNT");
    expect(countEv?.value).toBe(120);

    const maxAgeEv = evidence.find((e) => e.code === "MAXIMUM_AGE_HOURS");
    expect(maxAgeEv?.value).toBe("76.4h");
  });

  // 2. Trend increasing
  it("2. Trend increasing", () => {
    const history = [
      createHistoryRow("1", 100, "2026-08-05T00:00:00Z"),
      createHistoryRow("2", 120, "2026-08-05T06:00:00Z"),
    ];
    const context = buildRootCauseContext(dummyIncident, history);
    expect(context.trendDirection).toBe("increasing");
    expect(context.changePercent).toBe(20);
  });

  // 3. Trend decreasing
  it("3. Trend decreasing", () => {
    const inc: Incident = { ...dummyIncident, affectedOrderCount: 80 };
    const history = [
      createHistoryRow("1", 100, "2026-08-05T00:00:00Z"),
      createHistoryRow("2", 80, "2026-08-05T06:00:00Z"),
    ];
    const context = buildRootCauseContext(inc, history);
    expect(context.trendDirection).toBe("decreasing");
    expect(context.changePercent).toBe(-20);
  });

  // 4. Trend stable
  it("4. Trend stable", () => {
    const inc: Incident = { ...dummyIncident, affectedOrderCount: 100 };
    const history = [
      createHistoryRow("1", 100, "2026-08-05T00:00:00Z"),
      createHistoryRow("2", 100, "2026-08-05T06:00:00Z"),
    ];
    const context = buildRootCauseContext(inc, history);
    expect(context.trendDirection).toBe("stable");
    expect(context.changePercent).toBe(0);
  });

  // 5. Insufficient history
  it("5. Insufficient history", () => {
    const context = buildRootCauseContext(dummyIncident, []);
    expect(context.trendDirection).toBe("insufficient_data");
    expect(context.progressStatus).toBe("insufficient_data");
  });

  // 6. Strong progress classification
  it("6. Strong progress classification", () => {
    const inc: Incident = { ...dummyIncident, affectedOrderCount: 75 };
    const history = [
      createHistoryRow("1", 100, "2026-08-05T00:00:00Z"),
      createHistoryRow("2", 75, "2026-08-05T06:00:00Z"),
    ];
    const context = buildRootCauseContext(inc, history);
    expect(context.progressStatus).toBe("strong_progress");
  });

  // 7. No material progress classification
  it("7. No material progress classification", () => {
    const inc: Incident = { ...dummyIncident, affectedOrderCount: 98 };
    const history = [
      createHistoryRow("1", 100, "2026-08-05T00:00:00Z"),
      createHistoryRow("2", 98, "2026-08-05T06:00:00Z"),
    ];
    const context = buildRootCauseContext(inc, history);
    expect(context.progressStatus).toBe("no_material_progress");
  });

  // 8. Worsening classification
  it("8. Worsening classification", () => {
    const history = [
      createHistoryRow("1", 100, "2026-08-05T00:00:00Z"),
      createHistoryRow("2", 120, "2026-08-05T06:00:00Z"),
    ];
    const context = buildRootCauseContext(dummyIncident, history);
    expect(context.progressStatus).toBe("worsening");
  });

  // 9. Deterministic risk score
  it("9. Deterministic risk score", () => {
    const context = buildRootCauseContext(dummyIncident, []);
    const risk = calculateDeterministicRisk(context);

    // Count > 100 -> +30, MaxAge 76.4h -> +30, Insufficient history trend -> +15, Duration 6h -> +5
    expect(risk.score).toBe(80);
    expect(risk.level).toBe("critical");
  });

  // 10. Risk score capped at 100
  it("10. Risk score capped at 100", () => {
    const inc: Incident = {
      ...dummyIncident,
      maximumAgeHours: 120,
      affectedOrderCount: 500,
      firstDetectedAt: "2026-08-01T00:00:00Z",
      lastDetectedAt: "2026-08-05T00:00:00Z",
    };
    const history = [
      createHistoryRow("1", 100, "2026-08-01T00:00:00Z"),
      createHistoryRow("2", 500, "2026-08-05T00:00:00Z"),
    ];
    const context = buildRootCauseContext(inc, history);
    const risk = calculateDeterministicRisk(context);
    expect(risk.score).toBe(100);
  });

  // 11. Risk factors explain every contribution
  it("11. Risk factors explain every contribution", () => {
    const context = buildRootCauseContext(dummyIncident, []);
    const risk = calculateDeterministicRisk(context);
    const sumContributions = risk.factors.reduce((sum, f) => sum + f.contribution, 0);
    expect(sumContributions).toBe(risk.score);
  });

  // 12. AI output cannot replace deterministic risk score
  it("12. AI output cannot replace deterministic risk score", () => {
    const context = buildRootCauseContext(dummyIncident, []);
    const risk = calculateDeterministicRisk(context);
    const validCodes = new Set(["CURRENT_AFFECTED_COUNT"]);

    const rawAiText = JSON.stringify({
      summary: "AI tried to override risk score.",
      risk: { score: 10, level: "low", factors: [] }, // AI fake low score
    });

    const parsed = parseRootCauseResult(rawAiText, risk, validCodes, context);
    expect(parsed.risk.score).toBe(risk.score); // Forced to match deterministic risk!
    expect(parsed.risk.level).toBe(risk.level);
  });

  // 13. Unknown evidence codes are rejected
  it("13. Unknown evidence codes are rejected", () => {
    const context = buildRootCauseContext(dummyIncident, []);
    const risk = calculateDeterministicRisk(context);
    const validCodes = new Set(["CURRENT_AFFECTED_COUNT"]);

    const rawAiText = JSON.stringify({
      summary: "Test evidence codes.",
      causes: [
        {
          title: "Test",
          evidenceCodes: ["CURRENT_AFFECTED_COUNT", "FABRICATED_CODE"],
        },
      ],
    });

    const parsed = parseRootCauseResult(rawAiText, risk, validCodes, context);
    expect(parsed.causes[0].evidenceCodes).toEqual(["CURRENT_AFFECTED_COUNT"]); // Rejects FABRICATED_CODE!
  });

  // 14. Invalid provider JSON returns safe fallback
  it("14. Invalid provider JSON returns safe fallback", () => {
    const context = buildRootCauseContext(dummyIncident, []);
    const risk = calculateDeterministicRisk(context);

    const parsed = parseRootCauseResult("INVALID JSON TEXT", risk, new Set(), context);
    expect(parsed.summary).toContain("Đánh giá vận hành");
    expect(parsed.risk.score).toBe(risk.score);
  });

  // 15. No staffing recommendation when staffing data is absent
  it("15. No staffing recommendation when staffing data is absent", () => {
    const context = buildRootCauseContext(dummyIncident, []);
    const risk = calculateDeterministicRisk(context);

    const rawAiText = JSON.stringify({
      investigationSteps: [
        {
          priority: "high",
          action: "Dispatch 5 extra shippers to warehouse", // Unsafe operational command
          rationale: "Clear queue",
        },
      ],
    });

    const parsed = parseRootCauseResult(rawAiText, risk, new Set(), context);
    expect(parsed.investigationSteps[0].action).toContain("Kiểm tra và xác minh kế hoạch điều phối");
  });

  // 16. No vehicle recommendation when vehicle data is absent
  it("16. No vehicle recommendation when vehicle data is absent", () => {
    const context = buildRootCauseContext(dummyIncident, []);
    const evidence = buildDeterministicEvidence(context);
    const noVehicleEv = evidence.find((e) => e.code === "NO_VEHICLE_DATA");
    expect(noVehicleEv).toBeDefined();
    expect(noVehicleEv?.statement).toContain("Không có dữ liệu về phương tiện");
  });

  // 17. investigationSteps are limited to 5
  it("17. investigationSteps are limited to 5", () => {
    const context = buildRootCauseContext(dummyIncident, []);
    const risk = calculateDeterministicRisk(context);

    const steps = Array.from({ length: 10 }, (_, i) => ({
      priority: "medium",
      action: `Step ${i}`,
    }));

    const rawAiText = JSON.stringify({ investigationSteps: steps });
    const parsed = parseRootCauseResult(rawAiText, risk, new Set(), context);
    expect(parsed.investigationSteps.length).toBe(5);
  });

  // 18. Sample order data contains no PII
  it("18. sample order data contains no PII", () => {
    const context = buildRootCauseContext(dummyIncident, []);
    for (const code of context.sampleOrderCodes) {
      expect(code).not.toContain("@");
      expect(code).not.toContain("090");
    }
  });

  // 19. Prompt metadata version is loaded correctly
  it("19. Prompt metadata version is loaded correctly", () => {
    const meta = loadPromptMetadata("rootcause");
    expect(meta.name).toBe("rootcause");
    expect(meta.version).toBe("v3");
    expect(meta.language).toBe("vi");
  });

  // 20. RootCauseAgent imports no vendor SDK
  it("20. RootCauseAgent imports no vendor SDK", () => {
    const agentFileContent = fs.readFileSync("src/agents/root-cause/agent.ts", "utf-8");
    expect(agentFileContent).not.toContain('from "openai"');
    expect(agentFileContent).not.toContain("from 'openai'");
    expect(agentFileContent).not.toContain("@google/generative-ai");
  });

  it("21. direct pickup timestamp evidence overrides an unsupported AI cause", () => {
    const incident: Incident = {
      ...dummyIncident,
      pickupJourneyCoveragePercent: 80,
      pickupDelayedOrderCount: 1,
      maximumPickupWaitHours: 149.2,
      pickupDelayOrderCodes: ["GY8N9V8T"],
    };
    const context = buildRootCauseContext(incident, []);
    const evidence = buildDeterministicEvidence(context);
    const risk = calculateDeterministicRisk(context);
    const parsed = parseRootCauseResult(
      JSON.stringify({
        summary: "Có thể do trung chuyển.",
        causes: [{ title: "Trung chuyển trễ", confidence: 80, evidenceCodes: ["CURRENT_AFFECTED_COUNT"] }],
      }),
      risk,
      new Set(evidence.map((item) => item.code)),
      context
    );

    expect(parsed.causes[0]).toMatchObject({
      title: "Chậm xử lý tại đầu lấy",
      confidence: 95,
      evidenceCodes: ["PICKUP_DELAY_DIRECT"],
    });
    expect(parsed.causes[0].explanation).toContain("GY8N9V8T");
    expect(parsed.limitations).toContain(
      "Chưa đủ checkpoint hành trình để xác nhận thời gian từng chặng trung chuyển; kết luận hiện chỉ áp dụng cho đầu lấy."
    );
  });

  it("22. missing pickup timestamp produces a limitation instead of a pickup conclusion", () => {
    const context = buildRootCauseContext(dummyIncident, []);
    const evidence = buildDeterministicEvidence(context);

    expect(evidence.some((item) => item.code === "PICKUP_JOURNEY_DATA_MISSING")).toBe(true);
    expect(evidence.some((item) => item.code === "PICKUP_DELAY_DIRECT")).toBe(false);
  });
});
