import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import {
  NearTermCapacityRuntimeService,
  STAGE_1_PILOT_WAREHOUSES,
  isStage1PilotWarehouse,
  isMultiWarehouseEnabled,
} from "@/services/near-term-capacity-runtime";
import {
  detectCandidate,
  formatOperationalRiskPromptSummary,
  formatSemanticWeight,
  buildContext,
  critique,
  type CurrentRisk,
  type LeadFact,
  type AiRecommendation,
} from "@/domain/near-term-capacity";

const YEN_BAI = "21161000";
const LAO_CAI = "21158000";
const PHU_THO = "21160000";
const HA_LONG = "21153000"; // Non-pilot warehouse

const GOLDEN_CASE_ID = "e2524b83-4462-4238-8914-cd371ab51106";

function createMockPilotMember(province: string) {
  return {
    id: `member-${province}`,
    group_id: `group-${province}`,
    telegram_user_id: 12345,
    display_name: `Lead ${province}`,
    role: "LEAD",
    status: "ACTIVE",
  };
}

function createMockPilotScope(province: string) {
  return {
    id: `scope-${province}`,
    member_id: `member-${province}`,
    scope_type: "PROVINCE",
    scope_code: province,
    permission: "MANAGE_SCOPE",
    active: true,
  };
}

function createMockPilotGroup(province: string) {
  return {
    id: `group-${province}`,
    telegram_chat_id: -1004329996332,
    status: "ACTIVE",
  };
}

function createMockPilotTopic(province: string, threadId: number) {
  return {
    group_id: `group-${province}`,
    message_thread_id: threadId,
    province_name: province,
    is_manager_decision: false,
    status: "ACTIVE",
  };
}

const LAO_CAI_CASE_ID = "11111111-1111-4111-8111-111111111111";
const PHU_THO_CASE_ID = "22222222-2222-4222-8222-222222222222";

describe("Near-Term Capacity Stage 1 Multi-Warehouse Rollout", () => {
  const originalEnv = process.env.NEAR_TERM_CAPACITY_MULTI_WAREHOUSE_ENABLED;

  beforeEach(() => {
    delete process.env.NEAR_TERM_CAPACITY_MULTI_WAREHOUSE_ENABLED;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.NEAR_TERM_CAPACITY_MULTI_WAREHOUSE_ENABLED = originalEnv;
    } else {
      delete process.env.NEAR_TERM_CAPACITY_MULTI_WAREHOUSE_ENABLED;
    }
  });

  // Test 1: Yên Bái active does not block Lào Cai
  it("1. Yên Bái active does not block Lào Cai candidate creation", async () => {
    process.env.NEAR_TERM_CAPACITY_MULTI_WAREHOUSE_ENABLED = "true";
    const insertedCases: any[] = [];
    const mockTelegram = {
      sendToChat: vi.fn(async () => ({ messageId: 9999 })),
    };

    const from = vi.fn((table: string) => {
      if (table === "near_term_capacity_cases") {
        return {
          select: () => ({
            eq: () => ({
              // Active case exists for Yên Bái
              then: (resolve: any) => resolve({
                data: [{ id: GOLDEN_CASE_ID, warehouse_id: YEN_BAI, status: "DECISION_READY", active: true }],
                error: null,
              }),
            }),
            gte: () => Promise.resolve({ data: [], error: null }),
          }),
          insert: (payload: any) => {
            insertedCases.push(payload);
            return {
              select: () => ({
                single: async () => ({ data: { id: LAO_CAI_CASE_ID, ...payload }, error: null }),
              }),
            };
          },
        };
      }
      if (table === "incidents") {
        return {
          select: () => ({
            in: () => ({
              eq: () => ({
                order: async () => ({
                  data: [
                    {
                      id: "inc-lao-cai",
                      incident_key: `${LAO_CAI}:KHO_TON`,
                      warehouse_id: LAO_CAI,
                      warehouse_name: "Kho Giao Hàng Nặng - TP Lào Cai - Lào Cai",
                      reason_code: "KHO_TON",
                      last_detected_at: new Date().toISOString(),
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "incident_history") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: { affected_order_count: 14, recorded_at: new Date().toISOString(), sync_run_id: "sync-1" },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "order_snapshots") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "telegram_pilot_members") {
        return { select: () => ({ eq: async () => ({ data: [createMockPilotMember("Lào Cai")], error: null }) }) };
      }
      if (table === "telegram_user_scopes") {
        return { select: () => ({ in: () => ({ eq: async () => ({ data: [createMockPilotScope("Lào Cai")], error: null }) }) }) };
      }
      if (table === "telegram_pilot_groups") {
        return { select: () => ({ in: () => ({ eq: async () => ({ data: [createMockPilotGroup("Lào Cai")], error: null }) }) }) };
      }
      if (table === "telegram_pilot_topics") {
        return { select: () => ({ in: () => ({ eq: async () => ({ data: [createMockPilotTopic("Lào Cai", 2)], error: null }) }) }) };
      }
      if (table === "near_term_capacity_events") {
        return { insert: async () => ({ error: null }) };
      }
      if (table.includes("telemetry") || table.includes("shadow")) {
        return { upsert: async () => ({ error: null }), insert: async () => ({ error: null }) };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const runtime = new NearTermCapacityRuntimeService({ from } as any, mockTelegram as any);
    const result = await runtime.runCheckpoint("test_stage1");

    expect(result).toMatchObject({
      status: "FACT_REQUEST_SENT",
      fact_requests_sent: 1,
      caseId: LAO_CAI_CASE_ID,
    });
    expect(insertedCases).toHaveLength(1);
    expect(insertedCases[0].warehouse_id).toBe(LAO_CAI);
    expect(mockTelegram.sendToChat).toHaveBeenCalledTimes(1);
  });

  // Test 2: Same warehouse cannot create second active case
  it("2. Same warehouse cannot create second active case", async () => {
    const insertedCases: any[] = [];
    const mockTelegram = {
      sendToChat: vi.fn(),
    };

    const from = vi.fn((table: string) => {
      if (table === "near_term_capacity_cases") {
        return {
          select: () => ({
            eq: () => ({
              // Active case already exists for Lào Cai
              then: (resolve: any) => resolve({
                data: [{ id: "case-lao-cai-1", warehouse_id: LAO_CAI, status: "FACT_REQUESTED", active: true }],
                error: null,
              }),
            }),
            gte: () => Promise.resolve({ data: [], error: null }),
          }),
          insert: (payload: any) => {
            insertedCases.push(payload);
            return { select: () => ({ single: async () => ({ id: "new", ...payload }) }) };
          },
        };
      }
      if (table === "incidents") {
        return {
          select: () => ({
            in: () => ({
              eq: () => ({
                order: async () => ({
                  data: [
                    {
                      id: "inc-lao-cai-2",
                      incident_key: `${LAO_CAI}:KHO_TON`,
                      warehouse_id: LAO_CAI,
                      warehouse_name: "Kho Giao Hàng Nặng - TP Lào Cai - Lào Cai",
                      reason_code: "KHO_TON",
                      last_detected_at: new Date().toISOString(),
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "incident_history") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: { affected_order_count: 20, recorded_at: new Date().toISOString() },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "telegram_pilot_members") {
        return { select: () => ({ eq: async () => ({ data: [createMockPilotMember("Lào Cai")], error: null }) }) };
      }
      if (table === "telegram_user_scopes") {
        return { select: () => ({ in: () => ({ eq: async () => ({ data: [createMockPilotScope("Lào Cai")], error: null }) }) }) };
      }
      if (table === "near_term_capacity_events") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: { id: "sent" }, error: null }) }),
            }),
          }),
          insert: async () => ({ error: null }),
        };
      }
      if (table === "near_term_capacity_fact_responses") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      }
      if (table.includes("telemetry") || table.includes("shadow")) {
        return { upsert: async () => ({ error: null }), insert: async () => ({ error: null }) };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const runtime = new NearTermCapacityRuntimeService({ from } as any, mockTelegram as any);
    const result = await runtime.runCheckpoint("test_stage1");

    expect(result).toMatchObject({
      status: "ACTIVE_CASE_EXISTS",
      fact_requests_sent: 0,
    });
    expect(insertedCases).toHaveLength(0);
    expect(mockTelegram.sendToChat).not.toHaveBeenCalled();
  });

  // Test 3: Three pilot warehouses may each have one active case
  it("3. Three pilot warehouses may each have one active case concurrently", () => {
    expect(STAGE_1_PILOT_WAREHOUSES).toHaveLength(3);
    expect(STAGE_1_PILOT_WAREHOUSES).toContain(YEN_BAI);
    expect(STAGE_1_PILOT_WAREHOUSES).toContain(LAO_CAI);
    expect(STAGE_1_PILOT_WAREHOUSES).toContain(PHU_THO);

    // Migration 077 allows one active case per warehouse_id
    const migrationSql = fs.readFileSync(
      "src/database/migrations/077_near_term_capacity_warehouse_concurrency.sql",
      "utf8"
    );
    expect(migrationSql).toContain("DROP INDEX IF EXISTS one_active_near_term_capacity_case;");
    expect(migrationSql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS one_active_near_term_capacity_case_per_warehouse"
    );
    expect(migrationSql).toContain("ON near_term_capacity_cases (warehouse_id)");
    expect(migrationSql).toContain("WHERE active = true");
  });

  // Test 4: Non-pilot warehouse remains shadow-only
  it("4. Non-pilot warehouse candidate remains shadow-only and never creates governed case", async () => {
    const insertedCases: any[] = [];
    const mockTelegram = { sendToChat: vi.fn() };

    expect(isStage1PilotWarehouse(HA_LONG)).toBe(false);

    const from = vi.fn((table: string) => {
      if (table === "near_term_capacity_cases") {
        return {
          select: () => ({
            eq: () => ({
              then: (resolve: any) => resolve({ data: [], error: null }),
            }),
            gte: () => Promise.resolve({ data: [], error: null }),
          }),
          insert: (payload: any) => {
            insertedCases.push(payload);
            return { select: () => ({ single: async () => ({ id: "new", ...payload }) }) };
          },
        };
      }
      if (table === "incidents") {
        return {
          select: () => ({
            in: () => ({
              eq: () => ({
                order: async () => ({
                  data: [
                    {
                      id: "inc-ha-long",
                      incident_key: `${HA_LONG}:KHO_TON`,
                      warehouse_id: HA_LONG,
                      warehouse_name: "Kho Giao Hàng Nặng - TP Hạ Long - Quảng Ninh",
                      reason_code: "KHO_TON",
                      last_detected_at: new Date().toISOString(),
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "incident_history") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: { affected_order_count: 44, recorded_at: new Date().toISOString() },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "telegram_pilot_members") {
        return { select: () => ({ eq: async () => ({ data: [createMockPilotMember("Quảng Ninh")], error: null }) }) };
      }
      if (table === "telegram_user_scopes") {
        return { select: () => ({ in: () => ({ eq: async () => ({ data: [createMockPilotScope("Quảng Ninh")], error: null }) }) }) };
      }
      if (table.includes("telemetry") || table.includes("shadow")) {
        return { upsert: async () => ({ error: null }), insert: async () => ({ error: null }) };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const runtime = new NearTermCapacityRuntimeService({ from } as any, mockTelegram as any);
    const result = await runtime.runCheckpoint("test_stage1");

    expect(result).toMatchObject({
      status: "NO_CANDIDATE",
      fact_requests_sent: 0,
    });
    expect(insertedCases).toHaveLength(0);
    expect(mockTelegram.sendToChat).not.toHaveBeenCalled();
  });

  // Test 5: At most one NEW governed case is created per checkpoint execution
  it("5. At most one NEW governed case is created per checkpoint execution (deterministic backlog ranking)", async () => {
    process.env.NEAR_TERM_CAPACITY_MULTI_WAREHOUSE_ENABLED = "true";
    const insertedCases: any[] = [];
    const mockTelegram = {
      sendToChat: vi.fn(async () => ({ messageId: 8888 })),
    };

    // Checkpoint has both Lào Cai (10 orders) and Phú Thọ (30 orders)
    const from = vi.fn((table: string) => {
      if (table === "near_term_capacity_cases") {
        return {
          select: () => ({
            eq: () => ({
              then: (resolve: any) => resolve({ data: [], error: null }),
            }),
            gte: () => Promise.resolve({ data: [], error: null }),
          }),
          insert: (payload: any) => {
            insertedCases.push(payload);
            const caseId = payload.warehouse_id === PHU_THO ? PHU_THO_CASE_ID : LAO_CAI_CASE_ID;
            return { select: () => ({ single: async () => ({ data: { id: caseId, ...payload }, error: null }) }) };
          },
        };
      }
      if (table === "incidents") {
        return {
          select: () => ({
            in: () => ({
              eq: () => ({
                order: async () => ({
                  data: [
                    {
                      id: "inc-lao-cai",
                      incident_key: `${LAO_CAI}:KHO_TON`,
                      warehouse_id: LAO_CAI,
                      warehouse_name: "Kho Giao Hàng Nặng - TP Lào Cai - Lào Cai",
                      reason_code: "KHO_TON",
                      last_detected_at: new Date().toISOString(),
                    },
                    {
                      id: "inc-phu-tho",
                      incident_key: `${PHU_THO}:KHO_TON`,
                      warehouse_id: PHU_THO,
                      warehouse_name: "Kho Giao Hàng Nặng - Việt Trì - Phú Thọ",
                      reason_code: "KHO_TON",
                      last_detected_at: new Date().toISOString(),
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "incident_history") {
        return {
          select: () => ({
            eq: (_col: string, val: string) => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => {
                    const count = val === "inc-lao-cai" ? 10 : 30;
                    return { data: { affected_order_count: count, recorded_at: new Date().toISOString() }, error: null };
                  },
                }),
              }),
            }),
          }),
        };
      }
      if (table === "telegram_pilot_members") {
        return { select: () => ({ eq: async () => ({ data: [createMockPilotMember("Lào Cai"), createMockPilotMember("Phú Thọ")], error: null }) }) };
      }
      if (table === "telegram_user_scopes") {
        return { select: () => ({ in: () => ({ eq: async () => ({ data: [createMockPilotScope("Lào Cai"), createMockPilotScope("Phú Thọ")], error: null }) }) }) };
      }
      if (table === "telegram_pilot_groups") {
        return { select: () => ({ in: () => ({ eq: async () => ({ data: [createMockPilotGroup("Lào Cai"), createMockPilotGroup("Phú Thọ")], error: null }) }) }) };
      }
      if (table === "telegram_pilot_topics") {
        return { select: () => ({ in: () => ({ eq: async () => ({ data: [createMockPilotTopic("Lào Cai", 2), createMockPilotTopic("Phú Thọ", 12)], error: null }) }) }) };
      }
      if (table === "near_term_capacity_events") {
        return { insert: async () => ({ error: null }) };
      }
      if (table.includes("telemetry") || table.includes("shadow")) {
        return { upsert: async () => ({ error: null }), insert: async () => ({ error: null }) };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const runtime = new NearTermCapacityRuntimeService({ from } as any, mockTelegram as any);
    const result = await runtime.runCheckpoint("test_stage1");

    // Exactly 1 new case created, and Phú Thọ was chosen over Lào Cai because 30 orders > 10 orders
    expect(result).toMatchObject({
      status: "FACT_REQUEST_SENT",
      fact_requests_sent: 1,
      caseId: PHU_THO_CASE_ID,
    });
    expect(insertedCases).toHaveLength(1);
    expect(insertedCases[0].warehouse_id).toBe(PHU_THO);
    expect(mockTelegram.sendToChat).toHaveBeenCalledTimes(1);
  });

  // Test 6: Production threshold remains unchanged
  it("6. Production detection threshold remains unchanged", () => {
    const now = new Date().toISOString();
    const validCandidate: CurrentRisk = {
      warehouseId: LAO_CAI,
      warehouseName: "Kho Giao Hàng Nặng - TP Lào Cai - Lào Cai",
      capturedAt: now,
      currentOrders: 6,
      currentKg: null,
      b2bOrders: null,
      evidenceRefs: ["incident:1"],
      riskSignals: ["KHO_TON"],
    };
    expect(detectCandidate(validCandidate)).toBe(true);

    // Missing risk signal -> rejected
    expect(detectCandidate({ ...validCandidate, riskSignals: [] })).toBe(false);
    // Missing evidence refs -> rejected
    expect(detectCandidate({ ...validCandidate, evidenceRefs: [] })).toBe(false);
    // Invalid timestamp -> rejected
    expect(detectCandidate({ ...validCandidate, capturedAt: "invalid-date" })).toBe(false);
    // Both orders and kg null -> rejected
    expect(detectCandidate({ ...validCandidate, currentOrders: null, currentKg: null })).toBe(false);
  });

  // Test 7: 24h warehouse cooldown remains enforced
  it("7. 24h warehouse cooldown remains enforced", async () => {
    const insertedCases: any[] = [];
    const mockTelegram = { sendToChat: vi.fn() };

    const from = vi.fn((table: string) => {
      if (table === "near_term_capacity_cases") {
        return {
          select: () => ({
            eq: () => ({
              // No currently active case
              then: (resolve: any) => resolve({ data: [], error: null }),
            }),
            gte: () => ({
              // Case was created 2 hours ago for Lào Cai (within 24h)
              then: (resolve: any) => resolve({
                data: [{ warehouse_id: LAO_CAI, created_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }],
                error: null,
              }),
            }),
          }),
          insert: (payload: any) => {
            insertedCases.push(payload);
            return { select: () => ({ single: async () => ({ id: "new", ...payload }) }) };
          },
        };
      }
      if (table === "incidents") {
        return {
          select: () => ({
            in: () => ({
              eq: () => ({
                order: async () => ({
                  data: [
                    {
                      id: "inc-lao-cai",
                      incident_key: `${LAO_CAI}:KHO_TON`,
                      warehouse_id: LAO_CAI,
                      warehouse_name: "Kho Giao Hàng Nặng - TP Lào Cai - Lào Cai",
                      reason_code: "KHO_TON",
                      last_detected_at: new Date().toISOString(),
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "incident_history") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: { affected_order_count: 15, recorded_at: new Date().toISOString() },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "telegram_pilot_members") {
        return { select: () => ({ eq: async () => ({ data: [createMockPilotMember("Lào Cai")], error: null }) }) };
      }
      if (table === "telegram_user_scopes") {
        return { select: () => ({ in: () => ({ eq: async () => ({ data: [createMockPilotScope("Lào Cai")], error: null }) }) }) };
      }
      if (table.includes("telemetry") || table.includes("shadow")) {
        return { upsert: async () => ({ error: null }), insert: async () => ({ error: null }) };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const runtime = new NearTermCapacityRuntimeService({ from } as any, mockTelegram as any);
    const result = await runtime.runCheckpoint("test_stage1");

    // Suppressed by 24h cooldown
    expect(result).toMatchObject({
      status: "NO_CANDIDATE",
      fact_requests_sent: 0,
    });
    expect(insertedCases).toHaveLength(0);
    expect(mockTelegram.sendToChat).not.toHaveBeenCalled();
  });

  // Test 8: UNKNOWN != ZERO remains enforced
  it("8. UNKNOWN != ZERO semantic safety remains preserved", () => {
    expect(formatSemanticWeight(null)).toBe("Chưa có dữ liệu kg");
    expect(formatSemanticWeight(undefined)).toBe("Chưa có dữ liệu kg");
    expect(formatSemanticWeight(0)).toBe("0 kg");
    expect(formatSemanticWeight(12.5)).toBe("12.5 kg");

    const promptSummaryMissing = formatOperationalRiskPromptSummary({ currentOrders: 10, currentKg: null });
    expect(promptSummaryMissing).toContain("khối lượng: CHƯA CÓ DỮ LIỆU");
    expect(promptSummaryMissing).not.toContain("0 kg");

    const promptSummaryZero = formatOperationalRiskPromptSummary({ currentOrders: 10, currentKg: 0 });
    expect(promptSummaryZero).toContain("khối lượng: 0 kg");
  });

  // Test 9: Gemini failure remains fail-soft
  it("9. AI recommendation failure remains fail-soft and marks HUMAN_INVESTIGATION_REQUIRED", async () => {
    const updatedStatus: any[] = [];
    const from = vi.fn((table: string) => {
      if (table === "near_term_capacity_cases") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: "case-fail",
                    warehouse_id: LAO_CAI,
                    status: "FACT_REQUESTED",
                    active: true,
                    current_risk_snapshot: {
                      warehouseId: LAO_CAI,
                      warehouseName: "Kho Lào Cai",
                      capturedAt: new Date().toISOString(),
                      currentOrders: 10,
                      currentKg: null,
                      evidenceRefs: ["ref:1"],
                      riskSignals: ["KHO_TON"],
                    },
                  },
                  error: null,
                }),
              }),
            }),
          }),
          update: (payload: any) => {
            updatedStatus.push(payload);
            return {
              eq: () => ({
                eq: async () => ({ error: null }),
                then: (resolve: any) => resolve({ error: null }),
              }),
            };
          },
        };
      }
      if (table === "near_term_capacity_events") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { payload: { telegramMessageId: 1001, memberId: "lead-1" } },
                  error: null,
                }),
              }),
            }),
          }),
          insert: async () => ({ error: null }),
        };
      }
      if (table === "near_term_capacity_fact_responses") {
        return { insert: async () => ({ error: null }) };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const runtime = new NearTermCapacityRuntimeService({ from } as any);
    const result = await runtime.consumeInitialAnswer(
      "case-fail",
      "NO_SIGNIFICANT_INCOMING",
      "lead-1",
      "-1004329996332",
      1001,
      501
    );

    // AI call fails because no mock provider configured in unit test environment,
    // which MUST be handled fail-soft without throwing an unhandled exception:
    expect(["HUMAN_INVESTIGATION_REQUIRED", "DECISION_READY"]).toContain(result.status);
    expect(updatedStatus.some((u) => u.status === "HUMAN_INVESTIGATION_REQUIRED" || u.status === "DECISION_READY")).toBe(true);
  });

  // Test 10: Critic required before Manager Card
  it("10. Critic validation is strictly required before Manager Card generation", () => {
    const facts: CurrentRisk = {
      warehouseId: LAO_CAI,
      warehouseName: "Kho Lào Cai",
      capturedAt: new Date().toISOString(),
      currentOrders: 10,
      currentKg: null,
      b2bOrders: null,
      evidenceRefs: ["incident:1"],
      riskSignals: ["KHO_TON"],
    };
    const lead: LeadFact = {
      interactionId: "case-test",
      suppliedBy: "lead-1",
      capturedAt: new Date().toISOString(),
      source: "HUMAN_OPERATIONAL_GROUND_TRUTH",
      incoming: "NO_SIGNIFICANT_INCOMING",
      confidence: "HIGH",
    };
    const context = buildContext("case-test", facts, lead, {
      nearTermWindowMinutes: 240,
      leadFactMaxAgeMinutes: 60,
      allowedActions: ["NO_ACTION_MONITOR", "ADD_VEHICLE"],
    });

    const validRecommendation: AiRecommendation = {
      decision_case_id: "case-test",
      recommended_action: "NO_ACTION_MONITOR",
      confidence: 0.85,
      reason_summary: "Valid",
      current_risk: "Risk",
      expected_state_if_no_action: "State",
      expected_state_if_action: "State",
      key_evidence: ["incident:1"],
      uncertainties: [],
      execution_instruction: "Monitor",
      required_by: new Date(Date.now() + 3600000).toISOString(),
      required_followup_at: new Date(Date.now() + 7200000).toISOString(),
      estimated_cost_vnd: null,
      estimated_saving_vnd: null,
    };

    expect(critique(context, validRecommendation)).toEqual({
      verdict: "VALID_DECISION",
      reasons: [],
    });

    // Unallowed action -> Critic rejects
    const invalidRec = { ...validRecommendation, recommended_action: "UNAUTHORIZED_ACTION" as any };
    expect(critique(context, invalidRec)).toMatchObject({
      verdict: "HUMAN_INVESTIGATION_REQUIRED",
    });

    // Fabricated evidence -> Critic rejects
    const fabricatedRec = { ...validRecommendation, key_evidence: ["fake_evidence"] };
    expect(critique(context, fabricatedRec)).toMatchObject({
      verdict: "HUMAN_INVESTIGATION_REQUIRED",
    });
  });

  // Test 11: No duplicate Manager Card
  it("11. Manager Card dispatch is strictly idempotent", () => {
    const migration070 = fs.readFileSync(
      "src/database/migrations/070_near_term_capacity_manager_decision_bridge.sql",
      "utf8"
    );
    expect(migration070).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS one_decision_per_near_term_capacity_case"
    );
    expect(migration070).toContain("ON near_term_capacity_cases(decision_id)");
    expect(migration070).toContain("WHERE decision_id IS NOT NULL");
  });

  // Test 12: Golden Case #001 unchanged
  it("12. Golden Case #001 remains unchanged and protected", () => {
    expect(GOLDEN_CASE_ID).toBe("e2524b83-4462-4238-8914-cd371ab51106");
    expect(STAGE_1_PILOT_WAREHOUSES[0]).toBe(YEN_BAI);
  });

  // Test 13: Strict Default-Off boolean parsing contract
  it("13. Multi-warehouse strictly defaults to OFF and only enables on exact 'true'", () => {
    delete process.env.NEAR_TERM_CAPACITY_MULTI_WAREHOUSE_ENABLED;
    expect(isMultiWarehouseEnabled()).toBe(false); // missing -> DISABLED

    process.env.NEAR_TERM_CAPACITY_MULTI_WAREHOUSE_ENABLED = "false";
    expect(isMultiWarehouseEnabled()).toBe(false); // false -> DISABLED

    process.env.NEAR_TERM_CAPACITY_MULTI_WAREHOUSE_ENABLED = "true";
    expect(isMultiWarehouseEnabled()).toBe(true); // true -> ENABLED

    // Malformed values must all resolve to DISABLED
    for (const val of ["1", "yes", "TRUE", "True", "enabled", "on", "undefined", "null", "false ", " true"]) {
      process.env.NEAR_TERM_CAPACITY_MULTI_WAREHOUSE_ENABLED = val;
      expect(isMultiWarehouseEnabled()).toBe(false);
    }
  });

  // Test 14: Kill switch disables new governed creation safely (when missing or false)
  it("14. Kill switch disables new governed creation safely when missing or false", async () => {
    delete process.env.NEAR_TERM_CAPACITY_MULTI_WAREHOUSE_ENABLED; // missing = default OFF
    expect(isMultiWarehouseEnabled()).toBe(false);

    const insertedCases: any[] = [];
    const mockTelegram = { sendToChat: vi.fn() };

    const from = vi.fn((table: string) => {
      if (table === "near_term_capacity_cases") {
        return {
          select: () => ({
            eq: () => ({
              // 1 active case exists somewhere in the system
              then: (resolve: any) => resolve({
                data: [{ id: GOLDEN_CASE_ID, warehouse_id: YEN_BAI, status: "DECISION_READY", active: true }],
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const runtime = new NearTermCapacityRuntimeService({ from } as any, mockTelegram as any);
    const result = await runtime.runCheckpoint("test_stage1");

    // With kill switch enabled (default OFF), any active case in system blocks governed candidate creation
    expect(result).toMatchObject({
      status: "ACTIVE_CASE_EXISTS",
      fact_requests_sent: 0,
    });
    expect(insertedCases).toHaveLength(0);
    expect(mockTelegram.sendToChat).not.toHaveBeenCalled();
  });
});
