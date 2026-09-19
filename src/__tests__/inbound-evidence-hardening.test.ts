import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetUser = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () =>
    Promise.resolve({
      auth: {
        getUser: (token?: string) => mockGetUser(token),
      },
    }),
}));

import {
  formatCheckpointTimestamps,
  InboundEvidenceService,
  computeGovernedForecastHorizon,
  aggregateInboundBucket,
  classifyInboundCandidates,
  type NormalizedInboundCandidate,
} from "@/domain/near-term-capacity/inbound-evidence-service";
import {
  formatInboundEvidenceLeadPrompt,
  inboundEvidenceActionButtons,
  buildNearTermFactCallbackData,
  parseNearTermFactCallbackData,
} from "@/integrations/telegram/near-term-capacity-message";
import {
  resolveWarehouseTelegramTopic,
  assertValidOperationalTopic,
} from "@/integrations/telegram/topic-router";

describe("INBOUND_EVIDENCE_V2_SHADOW Hardening & Verification Suite", () => {
  const TARGET_WH = "21161000"; // Yên Bái Hub
  const UPSTREAM_WH = "21160000"; // Phú Thọ Hub

  beforeEach(() => {
    vi.restoreAllMocks();
    mockGetUser.mockReset();
  });

  // 1 & 2. Security: Unauthenticated and random bearer handling in route
  it("Test 1 & 2: route authorization security logic requires cron or MANAGE_SYSTEM", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Auth session missing" } });

    const { GET } = await import("@/app/api/internal/near-term-capacity/resume/route");

    // Case A: NO_AUTH
    const reqNoAuth = new NextRequest("http://localhost:3000/api/internal/near-term-capacity/resume?action=inbound-evidence");
    process.env.AUTH_ENFORCEMENT_ENABLED = "true";
    (process.env as any).NODE_ENV = "production";

    const resNoAuth = await GET(reqNoAuth);
    expect(resNoAuth.status).toBe(401);
    const dataNoAuth = await resNoAuth.json();
    expect(dataNoAuth.error).toBe("AUTHENTICATION_REQUIRED");

    // Case B: RANDOM_BEARER
    const reqRandomBearer = new NextRequest("http://localhost:3000/api/internal/near-term-capacity/resume?action=inbound-evidence", {
      headers: {
        authorization: "Bearer invalid_random_token_12345",
      },
    });
    const resRandomBearer = await GET(reqRandomBearer);
    expect(resRandomBearer.status).toBe(401);
    const dataRandomBearer = await resRandomBearer.json();
    expect(dataRandomBearer.error).toBe("AUTHENTICATION_REQUIRED");
  });

  // 3 & 4. Natural vs Replay Classification
  it("Test 3 & 4: distinguishes NATURAL vs REPLAY observation types", async () => {
    const mockDb = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            order: vi.fn(() => ({
              limit: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: "sync-1",
                    started_at: "2026-09-19T06:00:00Z",
                    checkpoint_at: "2026-09-19T06:00:00Z",
                    source_updated_at: "2026-09-19T06:00:00Z",
                  },
                }),
              })),
            })),
          })),
          or: vi.fn(() => ({
            eq: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
            })),
          })),
        })),
      })),
    } as any;

    const service = new InboundEvidenceService(mockDb);

    // Natural mode (no options.isReplay)
    const naturalSnap = await service.computeInboundEvidence(
      TARGET_WH,
      "Yên Bái Hub",
      new Date()
    );
    expect(naturalSnap.observation_type).toBe("NATURAL");

    // Replay mode (isReplay = true)
    const replaySnap = await service.computeInboundEvidence(
      TARGET_WH,
      "Yên Bái Hub",
      "2026-09-19T13:00:00+07:00",
      { isReplay: true }
    );
    expect(replaySnap.observation_type).toBe("REPLAY");
  });

  // 5. Timezone semantics: 13:00 +07 == 06:00Z
  it("Test 5: converts +07 local time to UTC accurately (13:00 ICT == 06:00Z)", () => {
    const localInput = "2026-09-19T13:00:00+07:00";
    const info = formatCheckpointTimestamps(localInput);

    expect(info.checkpoint_at_utc).toBe("2026-09-19T06:00:00.000Z");
    expect(info.checkpoint_at_local).toBe("2026-09-19T13:00:00+07:00");
    expect(info.timezone).toBe("Asia/Ho_Chi_Minh");
  });

  // 6 & 7. Replay future data guard & filtering
  it("Test 6 & 7: excludes data newer than checkpoint_at_utc and flags INVALID_FUTURE_DATA", async () => {
    const checkpointTime = "2026-09-19T13:00:00+07:00"; // 06:00:00Z

    // Scenario A: DB has sync run updated AFTER checkpoint
    const mockDbFuture = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            order: vi.fn(() => ({
              limit: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: "sync-future",
                    started_at: "2026-09-19T07:00:00Z", // Future relative to 06:00Z
                    checkpoint_at: "2026-09-19T07:00:00Z",
                    source_updated_at: "2026-09-19T07:00:00Z",
                  },
                }),
              })),
            })),
          })),
          or: vi.fn(() => ({
            eq: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue({
                data: [
                  {
                    order_code: "ORD_PAST",
                    warehouse_id: UPSTREAM_WH,
                    deliver_warehouse_id: TARGET_WH,
                    source_status: "transporting",
                    created_at: "2026-09-19T05:30:00Z", // Past: included
                  },
                  {
                    order_code: "ORD_FUTURE",
                    warehouse_id: UPSTREAM_WH,
                    deliver_warehouse_id: TARGET_WH,
                    source_status: "transporting",
                    created_at: "2026-09-19T06:30:00Z", // Future: must be filtered out
                  },
                ],
                error: null,
              }),
            })),
          })),
        })),
      })),
    } as any;

    const service = new InboundEvidenceService(mockDbFuture);
    const snap = await service.computeInboundEvidence(
      TARGET_WH,
      "Yên Bái Hub",
      checkpointTime,
      { isReplay: true }
    );

    expect(snap.replay_evidence_status).toBe("INVALID_FUTURE_DATA");
    // Only the past order should survive the replay filter
    expect(snap.inbound.pipeline_orders).toBe(1);
    expect(snap.inbound.allInboundOrderCodes).toEqual(["ORD_PAST"]);
  });

  // 8 & 9. Pipeline Volume vs Near-Term Horizon Arrival Separation
  it("Test 8 & 9: separates pipeline volume from near-term arrival; arrival_within_horizon is UNKNOWN", async () => {
    const mockDb = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            order: vi.fn(() => ({
              limit: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: "sync-1",
                    started_at: "2026-09-19T05:00:00Z",
                    checkpoint_at: "2026-09-19T05:00:00Z",
                    source_updated_at: "2026-09-19T05:00:00Z",
                  },
                }),
              })),
            })),
          })),
          or: vi.fn(() => ({
            eq: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue({
                data: [
                  {
                    order_code: "ORD_TR_1",
                    warehouse_id: UPSTREAM_WH,
                    deliver_warehouse_id: TARGET_WH,
                    source_status: "transporting",
                    weight_kg: 20.0,
                    created_at: "2026-09-19T04:00:00Z",
                  },
                  {
                    order_code: "ORD_PICKED_2",
                    warehouse_id: UPSTREAM_WH,
                    deliver_warehouse_id: TARGET_WH,
                    source_status: "picked",
                    weight_kg: 15.0,
                    created_at: "2026-09-19T04:10:00Z",
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
    const snap = await service.computeInboundEvidence(
      TARGET_WH,
      "Yên Bái Hub",
      "2026-09-19T11:00:00+07:00"
    );

    // Total pipeline has 2 orders
    expect(snap.inbound.pipeline_orders).toBe(2);
    expect(snap.inbound.picked_not_transferred_orders).toBe(1);
    expect(snap.inbound.in_transfer_orders).toBe(1);

    // ETA is not available -> arrival within horizon must be UNKNOWN (null)
    expect(snap.inbound.eta_known_orders).toBe(0);
    expect(snap.inbound.eta_unknown_orders).toBe(2);
    expect(snap.inbound.arrival_within_horizon_orders).toBeNull();
    expect(snap.inbound.arrival_within_horizon_status).toBe("UNKNOWN");
  });

  // 10. Risk Model Decoupling
  it("Test 10: decouples pipeline pressure (volume-based) from near-term arrival risk (ETA-based)", async () => {
    // Generate 60 in-transfer orders (high pipeline pressure)
    const largeVolumeOrders = Array.from({ length: 60 }, (_, i) => ({
      order_code: `ORD_${i}`,
      warehouse_id: UPSTREAM_WH,
      deliver_warehouse_id: TARGET_WH,
      source_status: "transporting",
      weight_kg: 10.0,
      created_at: "2026-09-19T04:00:00Z",
    }));

    const mockDb = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            order: vi.fn(() => ({
              limit: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: "sync-1",
                    started_at: "2026-09-19T04:00:00Z",
                  },
                }),
              })),
            })),
          })),
          or: vi.fn(() => ({
            eq: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue({
                data: largeVolumeOrders,
                error: null,
              }),
            })),
          })),
        })),
      })),
    } as any;

    const service = new InboundEvidenceService(mockDb);
    const snap = await service.computeInboundEvidence(
      TARGET_WH,
      "Yên Bái Hub",
      "2026-09-19T11:00:00+07:00"
    );

    // Pipeline pressure is HIGH due to large upstream volume (>50 orders)
    expect(snap.riskAssessment.pipeline_pressure).toBe("HIGH");
    // Near-term arrival risk remains UNKNOWN because no ETA exists
    expect(snap.riskAssessment.near_term_arrival_risk).toBe("UNKNOWN");
    expect(snap.riskAssessment.summaryVi).toContain("Lượng hàng upstream trong pipeline đang lớn");
    expect(snap.riskAssessment.summaryVi).toContain("Chưa đủ bằng chứng xác định bao nhiêu đơn sẽ về trước 17:00");
  });

  // 11 & 12. Telegram Safe Wording & No Lead Entry Prompts
  it("Test 11 & 12: renders safe pipeline wording without 'sắp về' and without Lead KG/ETA manual inputs", () => {
    const testSnapshot = {
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
        orderCount: 10,
        knownOrders: 10,
        knownWeightKg: 200,
        unknownWeightOrders: 0,
        orderCodes: ["ORD-1"],
      },
      inbound: {
        pipeline_orders: 136,
        pipeline_known_kg: 2400,
        pipeline_unknown_weight_orders: 0,
        picked_not_transferred_orders: 80,
        in_transfer_orders: 56,
        arrival_within_horizon_orders: null,
        arrival_within_horizon_status: "UNKNOWN" as const,
        eta_known_orders: 0,
        eta_unknown_orders: 136,
        earliestEta: null,
        latestEta: null,
        totalInboundOrders: 136,
        pickedNotTransferred: {
          orderCount: 80,
          knownOrders: 80,
          knownWeightKg: 1400,
          unknownWeightOrders: 0,
          orderCodes: [],
        },
        inTransfer: {
          orderCount: 56,
          knownOrders: 56,
          knownWeightKg: 1000,
          unknownWeightOrders: 0,
          orderCodes: [],
        },
        arrivalConfirmedExcluded: {
          orderCount: 0,
          knownOrders: 0,
          knownWeightKg: 0,
          unknownWeightOrders: 0,
          orderCodes: [],
        },
        etaKnownOrders: 0,
        etaUnknownOrders: 136,
        allInboundOrderCodes: [],
      },
      riskAssessment: {
        pipeline_pressure: "HIGH" as const,
        near_term_arrival_risk: "UNKNOWN" as const,
        preliminaryRiskLevel: "INVESTIGATION_REQUIRED" as const,
        summaryVi: "Lượng hàng upstream trong pipeline đang lớn (136 đơn).",
      },
    };

    const promptText = formatInboundEvidenceLeadPrompt(testSnapshot);

    // Strict positive checks
    expect(promptText).toContain("🚚 HÀNG ĐANG TRONG PIPELINE VỀ KHO");
    expect(promptText).toContain("Đã lấy / đang chờ luân chuyển: 80 đơn / 1400 kg");
    expect(promptText).toContain("Đang luân chuyển về kho: 56 đơn / 1000 kg");
    expect(promptText).toContain("ETA xác định: 0/136 đơn");
    expect(promptText).toContain("Thời điểm hàng về: CHƯA XÁC ĐỊNH");

    // Strict negative checks (prohibited terms)
    expect(promptText).not.toContain("sắp về");
    expect(promptText).not.toContain("HÀNG DỰ KIẾN VỀ");
    expect(promptText).not.toContain("Vui lòng nhập");
    expect(promptText).not.toContain("Nhập khối lượng");
    expect(promptText).not.toContain("Nhập giờ hàng về");

    // Action buttons check
    expect(inboundEvidenceActionButtons).toHaveLength(3);
    expect(inboundEvidenceActionButtons[0][0]).toBe("✅ Đã có phương án");
  });

  // 13. UNKNOWN != ZERO weight handling
  it("Test 13: UNKNOWN != ZERO ensures unmeasured items are never reported as 0 kg", () => {
    const items = [
      { orderCode: "A", weightKg: null },
      { orderCode: "B", weightKg: 15.0 },
    ];
    const bucket = aggregateInboundBucket(items);
    expect(bucket.orderCount).toBe(2);
    expect(bucket.knownOrders).toBe(1);
    expect(bucket.knownWeightKg).toBe(15.0);
    expect(bucket.unknownWeightOrders).toBe(1);
  });

  // 14. Telegram fail-closed topic routing
  it("Test 14: fail-closed topic routing rejects General and unmapped warehouses", async () => {
    const mockDb = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            })),
          })),
        })),
      })),
    } as any;

    const result = await resolveWarehouseTelegramTopic(mockDb, {
      warehouseId: "99999999", // unmapped
      warehouseName: "Unmapped Warehouse",
      role: "LEAD",
    });

    expect(result.status).toBe("TOPIC_MAPPING_MISSING");
    expect(() => assertValidOperationalTopic(result)).toThrow(
      /TELEGRAM_ROUTING_STATUS: TOPIC_MAPPING_MISSING/
    );
  });

  // 15. Decision Integrity: Callback serialization and no autonomous actions
  it("Test 15: preserves callback serialization without autonomous actions", () => {
    const caseId = "d734e56b-67a8-4e56-b789-0123456789ab";
    const serialized = buildNearTermFactCallbackData(caseId, "ACTION_PLANNED");
    expect(serialized).toBe(`opspcap:${caseId}:P`);

    const parsed = parseNearTermFactCallbackData(serialized);
    expect(parsed).toEqual({
      caseId,
      answer: "ACTION_PLANNED",
    });
  });
});
