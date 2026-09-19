import { describe, expect, it, vi } from "vitest";
import {
  aggregateInboundBucket,
  classifyInboundCandidates,
  computeGovernedForecastHorizon,
  InboundEvidenceService,
  type NormalizedInboundCandidate,
} from "@/domain/near-term-capacity/inbound-evidence-service";
import {
  buildNearTermFactCallbackData,
  formatInboundEvidenceLeadPrompt,
  formatOperationalExceptionPrompt,
  inboundEvidenceActionButtons,
  parseNearTermFactCallbackData,
} from "@/integrations/telegram/near-term-capacity-message";
import { isInboundEvidenceShadowEnabled } from "@/services/near-term-capacity-runtime";

describe("Evidence-Based Inbound Detection Engine (Criteria 11–24)", () => {
  const TARGET_WH = "21161000"; // Yên Bái Hub
  const UPSTREAM_WH = "21160000"; // Phú Thọ Hub

  it("Criterion 11: excludes ARRIVAL_CONFIRMED orders (already at warehouse) from future inbound", () => {
    const rawOrders: NormalizedInboundCandidate[] = [
      {
        orderCode: "ORDER_ARRIVED_1",
        currentWarehouseId: TARGET_WH, // already at target
        deliverWarehouseId: TARGET_WH,
        weightKg: 25.0,
      },
      {
        orderCode: "ORDER_ARRIVED_2",
        currentWarehouseId: TARGET_WH,
        deliverWarehouseId: TARGET_WH,
        weightKg: null,
      },
      {
        orderCode: "ORDER_INBOUND_1",
        currentWarehouseId: UPSTREAM_WH, // upstream
        deliverWarehouseId: TARGET_WH,
        sourceStatus: "transporting",
        weightKg: 30.0,
      },
    ];

    const classified = classifyInboundCandidates(TARGET_WH, rawOrders);

    // Arrived orders are in arrivalConfirmed (backlog), NOT in transfer or picked
    expect(classified.arrivalConfirmed.map((o) => o.orderCode)).toEqual([
      "ORDER_ARRIVED_1",
      "ORDER_ARRIVED_2",
    ]);
    expect(classified.inTransfer.map((o) => o.orderCode)).toEqual([
      "ORDER_INBOUND_1",
    ]);
    expect(classified.pickedNotTransferred).toHaveLength(0);
  });

  it("Criterion 12: classifies in-transit orders bound for target as IN_TRANSFER", () => {
    const rawOrders: NormalizedInboundCandidate[] = [
      {
        orderCode: "ORDER_TR_1",
        currentWarehouseId: UPSTREAM_WH,
        deliverWarehouseId: TARGET_WH,
        sourceStatus: "transporting",
        weightKg: 15.5,
      },
      {
        orderCode: "ORDER_TR_2",
        currentWarehouseId: UPSTREAM_WH,
        deliverWarehouseId: TARGET_WH,
        phase: "IN_TRANSIT",
        weightKg: 20.0,
      },
    ];

    const classified = classifyInboundCandidates(TARGET_WH, rawOrders);
    expect(classified.inTransfer.map((o) => o.orderCode)).toEqual([
      "ORDER_TR_1",
      "ORDER_TR_2",
    ]);
  });

  it("Criterion 13: classifies picked/storing orders waiting for transfer as PICKED_NOT_TRANSFERRED", () => {
    const rawOrders: NormalizedInboundCandidate[] = [
      {
        orderCode: "ORDER_PICKED_1",
        currentWarehouseId: UPSTREAM_WH,
        deliverWarehouseId: TARGET_WH,
        sourceStatus: "picked",
        endPickAt: "2026-09-19T08:00:00+07:00",
        weightKg: 10.0,
      },
      {
        orderCode: "ORDER_STORING_2",
        currentWarehouseId: UPSTREAM_WH,
        deliverWarehouseId: TARGET_WH,
        sourceStatus: "storing",
        weightKg: null,
      },
    ];

    const classified = classifyInboundCandidates(TARGET_WH, rawOrders);
    expect(classified.pickedNotTransferred.map((o) => o.orderCode)).toEqual([
      "ORDER_PICKED_1",
      "ORDER_STORING_2",
    ]);
  });

  it("Criterion 14: strictly deduplicates by orderCode and guarantees mutual exclusion", () => {
    const rawOrders: NormalizedInboundCandidate[] = [
      {
        orderCode: "DUP_ORDER",
        currentWarehouseId: UPSTREAM_WH,
        deliverWarehouseId: TARGET_WH,
        sourceStatus: "transporting",
        weightKg: 50.0,
      },
      {
        orderCode: "DUP_ORDER", // duplicate occurrence
        currentWarehouseId: UPSTREAM_WH,
        deliverWarehouseId: TARGET_WH,
        sourceStatus: "picked",
        weightKg: 50.0,
      },
    ];

    const classified = classifyInboundCandidates(TARGET_WH, rawOrders);
    expect(classified.inTransfer.map((o) => o.orderCode)).toEqual(["DUP_ORDER"]);
    expect(classified.pickedNotTransferred).toHaveLength(0);
  });

  it("Criterion 15: preserves exact order identifiers in the aggregate result", () => {
    const orders = [
      { orderCode: "CODE_ALPHA", weightKg: 12.3 },
      { orderCode: "CODE_BETA", weightKg: null },
      { orderCode: "CODE_GAMMA", weightKg: 4.7 },
    ];
    const bucket = aggregateInboundBucket(orders);

    expect(bucket.orderCodes).toEqual(["CODE_ALPHA", "CODE_BETA", "CODE_GAMMA"]);
    expect(bucket.orderCount).toBe(3);
  });

  it("Criterion 16: enforces Delivery Operating Window (outside 07:00–17:00 ICT returns OUTSIDE_OPERATING_WINDOW)", () => {
    // 21:00 ICT (after 17:00)
    const nightTime = "2026-09-19T21:00:00+07:00";
    const horizonResult = computeGovernedForecastHorizon(nightTime);
    expect(horizonResult.isWithinWindow).toBe(false);
    expect(horizonResult.horizon).toBeNull();

    // 05:30 ICT (before 07:00)
    const earlyMorning = "2026-09-19T05:30:00+07:00";
    const earlyResult = computeGovernedForecastHorizon(earlyMorning);
    expect(earlyResult.isWithinWindow).toBe(false);
    expect(earlyResult.horizon).toBeNull();
  });

  it.each(["2026-09-19T06:59:00+07:00", "2026-09-19T17:00:00+07:00", "2026-09-19T21:00:00+07:00"])("Criterion 16B: outside window keeps arrival risk UNKNOWN at %s", async (checkpointAt) => {
    const mockDb = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            order: vi.fn(() => ({
              limit: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: "sync-1", started_at: "2026-09-19T01:00:00Z" } }) })),
            })),
          })),
          or: vi.fn(() => ({ eq: vi.fn(() => ({ limit: vi.fn().mockResolvedValue({ data: [], error: null }) })) })),
        })),
      })),
    } as any;
    const snapshot = await new InboundEvidenceService(mockDb).computeReplayInboundEvidence(TARGET_WH, "Yên Bái Hub", checkpointAt);
    expect(snapshot.status).toBe("OUTSIDE_OPERATING_WINDOW");
    expect(snapshot.riskAssessment.near_term_arrival_risk).toBe("UNKNOWN");
  });

  it("Criterion 17: computes 4-hour forecast horizon within operating window", () => {
    // 10:00 ICT -> 4h horizon -> 14:00 ICT
    const midMorning = "2026-09-19T10:00:00+07:00";
    const result = computeGovernedForecastHorizon(midMorning);
    expect(result.isWithinWindow).toBe(true);
    expect(result.horizon).not.toBeNull();
    expect(result.horizon?.durationMinutes).toBe(240); // 4 hours
  });

  it("Criterion 18: caps forecast horizon at daily operating closing (17:00 ICT)", () => {
    // 15:30 ICT -> normally +4h would be 19:30, but capped at 17:00 -> 1.5h (90 mins)
    const lateAfternoon = "2026-09-19T15:30:00+07:00";
    const result = computeGovernedForecastHorizon(lateAfternoon);
    expect(result.isWithinWindow).toBe(true);
    expect(result.horizon).not.toBeNull();
    expect(result.horizon?.durationMinutes).toBe(90); // 1.5 hours
    expect(result.horizon?.end).toBe(new Date("2026-09-19T17:00:00+07:00").toISOString());
  });

  it("Criterion 19: implements UNKNOWN != ZERO weight semantics (separates known vs unknown)", () => {
    const orders = [
      { orderCode: "ORD_1", weightKg: 10.5 },
      { orderCode: "ORD_2", weightKg: null }, // unknown
      { orderCode: "ORD_3", weightKg: undefined as any }, // unknown
      { orderCode: "ORD_4", weightKg: 14.5 },
    ];
    const bucket = aggregateInboundBucket(orders);

    expect(bucket.orderCount).toBe(4);
    expect(bucket.knownOrders).toBe(2);
    expect(bucket.knownWeightKg).toBe(25.0);
    expect(bucket.unknownWeightOrders).toBe(2);
  });

  it("Criterion 20: zero fabrication (never converts unknown weight to 0 kg or extrapolates)", () => {
    const orders = [
      { orderCode: "ORD_NO_WEIGHT", weightKg: null },
    ];
    const bucket = aggregateInboundBucket(orders);

    expect(bucket.knownOrders).toBe(0);
    expect(bucket.knownWeightKg).toBe(0);
    expect(bucket.unknownWeightOrders).toBe(1);
  });

  it("Criterion 21: ETA semantics (real tracking evidence only, otherwise ETA_UNKNOWN)", async () => {
    const mockDb = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            order: vi.fn(() => ({
              limit: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: "sync-1" } }),
              })),
            })),
          })),
          or: vi.fn(() => ({
            eq: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue({
                data: [
                  {
                    order_code: "ORD_WITH_ETA",
                    current_warehouse_id: UPSTREAM_WH,
                    deliver_warehouse_id: TARGET_WH,
                    source_status: "transporting",
                    weight_kg: 20.0,
                    source_observed_at: "2026-09-19T03:00:00Z",
                  },
                ],
                error: null,
              }),
            })),
          })),
        })),
      })),
    } as any;

    const service = new InboundEvidenceService(mockDb);
    // Execute at 11:00 ICT
    const snapshot = await service.computeReplayInboundEvidence(
      TARGET_WH,
      "Yên Bái Hub",
      "2026-09-19T11:00:00+07:00"
    );

    expect(snapshot.status).toBe("AVAILABLE");
    // Since no explicit ETA was in tracking, order is counted as etaUnknownOrders
    expect(snapshot.inbound.etaUnknownOrders).toBe(1);
    expect(snapshot.inbound.etaKnownOrders).toBe(0);
    expect(snapshot.inbound.earliestEta).toBeNull();
  });

  it("Criterion 22: fail-soft degradation (database error returns UNAVAILABLE without crashing)", async () => {
    const failingDb = {
      from: vi.fn(() => {
        throw new Error("DB_CONNECTION_TIMEOUT");
      }),
    } as any;

    const service = new InboundEvidenceService(failingDb);
    const snapshot = await service.computeReplayInboundEvidence(
      TARGET_WH,
      "Yên Bái Hub",
      "2026-09-19T11:00:00+07:00"
    );

    expect(snapshot.status).toBe("UNAVAILABLE");
    expect(snapshot.diagnostics?.error).toContain("DB_CONNECTION_TIMEOUT");
    expect(snapshot.riskAssessment.preliminaryRiskLevel).toBe("INVESTIGATION_REQUIRED");
  });

  it("Criterion 23: Lead UX Redesign formats decision-first message with 3 action buttons", () => {
    const snapshot = {
      status: "AVAILABLE" as const,
      warehouseId: TARGET_WH,
      warehouseName: "Kho Giao Hàng Nặng - TP Yên Bái",
      capturedAt: "2026-09-19T10:00:00+07:00",
      checkpoint_at_utc: "2026-09-19T03:00:00.000Z",
      checkpoint_at_local: "2026-09-19T10:00:00+07:00",
      timezone: "Asia/Ho_Chi_Minh" as const,
      observation_type: "NATURAL" as const,
      operatingWindow: {
        timezone: "Asia/Ho_Chi_Minh",
        dailyStart: "07:00",
        dailyEnd: "17:00",
        isWithinWindow: true,
      },
      horizon: {
        start: "2026-09-19T10:00:00+07:00",
        end: "2026-09-19T14:00:00+07:00",
        durationMinutes: 240,
      },
      currentBacklog: {
        orderCount: 15,
        knownOrders: 12,
        knownWeightKg: 420.5,
        unknownWeightOrders: 3,
        orderCodes: ["ORD-1", "ORD-2"],
      },
      inbound: {
        pipeline_orders: 8,
        pipeline_known_kg: 235.0,
        pipeline_unknown_weight_orders: 1,
        picked_not_transferred_orders: 5,
        in_transfer_orders: 3,
        arrival_within_horizon_orders: null,
        arrival_within_horizon_status: "UNKNOWN" as const,
        eta_known_orders: 0,
        eta_unknown_orders: 8,
        earliestEta: null,
        latestEta: null,

        totalInboundOrders: 8,
        pickedNotTransferred: {
          orderCount: 5,
          knownOrders: 4,
          knownWeightKg: 150.0,
          unknownWeightOrders: 1,
          orderCodes: ["P-1"],
        },
        inTransfer: {
          orderCount: 3,
          knownOrders: 3,
          knownWeightKg: 85.0,
          unknownWeightOrders: 0,
          orderCodes: ["T-1"],
        },
        arrivalConfirmedExcluded: {
          orderCount: 2,
          knownOrders: 2,
          knownWeightKg: 40.0,
          unknownWeightOrders: 0,
          orderCodes: ["A-1"],
        },
        etaKnownOrders: 0,
        etaUnknownOrders: 8,
        allInboundOrderCodes: ["P-1", "T-1"],
      },
      riskAssessment: {
        pipeline_pressure: "LOW" as const,
        near_term_arrival_risk: "UNKNOWN" as const,
        preliminaryRiskLevel: "MEDIUM" as const,
        summaryVi: "Có 8 đơn dự kiến về trong khung giờ vận hành.",
      },
    };

    const text = formatInboundEvidenceLeadPrompt(snapshot);
    expect(text).toContain("CẢNH BÁO NĂNG LỰC XỬ LÝ");
    expect(text).toContain("Kho Giao Hàng Nặng - TP Yên Bái");
    expect(text).toContain("15 đơn");
    expect(text).toContain("420.5 kg (12 đơn)");
    expect(text).toContain("Đơn chưa có khối lượng: 3 đơn");
    expect(text).toContain("🚚 HÀNG ĐANG TRONG PIPELINE VỀ KHO");
    expect(text).toContain("Đã lấy / đang chờ luân chuyển: 5 đơn / 150 kg; 1 đơn chưa có kg");
    expect(text).toContain("Đang luân chuyển về kho: 3 đơn / 85 kg");
    expect(text).toContain("ETA xác định: 0/8 đơn");
    expect(text).toContain("Thời điểm hàng về: CHƯA XÁC ĐỊNH");
    expect(text).not.toContain("sắp về");
    expect(text).not.toContain("HÀNG DỰ KIẾN VỀ");

    // Check 3 quick-action buttons
    expect(inboundEvidenceActionButtons.map(([label]) => label)).toEqual([
      "✅ Đã có phương án",
      "⚠️ Có ngoại lệ",
      "🆘 Cần hỗ trợ",
    ]);

    // Check callback round-tripping for the 3 new actions
    const caseId = "c2e56db6-44c1-4cb5-8fa9-83c9d7ba9182";
    expect(
      parseNearTermFactCallbackData(buildNearTermFactCallbackData(caseId, "ACTION_PLANNED"))
    ).toEqual({ caseId, answer: "ACTION_PLANNED" });

    expect(
      parseNearTermFactCallbackData(buildNearTermFactCallbackData(caseId, "EXCEPTION_REPORTED"))
    ).toEqual({ caseId, answer: "EXCEPTION_REPORTED" });

    expect(
      parseNearTermFactCallbackData(buildNearTermFactCallbackData(caseId, "ASSISTANCE_REQUESTED"))
    ).toEqual({ caseId, answer: "ASSISTANCE_REQUESTED" });

    // Check operational exception prompt
    expect(formatOperationalExceptionPrompt()).toContain(
      "reply tin nhắn này để nêu rõ ngoại lệ vận hành tại kho"
    );
  });

  it("Criterion 24: shadow mode runs side-by-side with PRODUCTION_TELEGRAM_CHANGED: NO", () => {
    // Default shadow mode is enabled
    expect(isInboundEvidenceShadowEnabled()).toBe(true);
  });
});
