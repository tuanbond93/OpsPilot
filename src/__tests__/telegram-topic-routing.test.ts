import { describe, expect, it, vi } from "vitest";
import {
  assertValidOperationalTopic,
  normalizeProvinceName,
  resolveWarehouseTelegramTopic,
  TELEGRAM_ROUTING_LIMITATION_NOTE,
} from "@/integrations/telegram/topic-router";
import { TelegramClient } from "@/integrations/telegram/telegram-client";

// Mock Supabase database with pilot groups and topics
function createMockSupabase(overrides: {
  groups?: any[];
  topics?: any[];
} = {}) {
  const groups = overrides.groups ?? [
    { id: "group-mb03", telegram_chat_id: "-1001234567890", status: "ACTIVE" },
  ];
  const topics = overrides.topics ?? [
    {
      id: "topic-yen-bai",
      group_id: "group-mb03",
      message_thread_id: 101,
      topic_title: "Yên Bái Hub",
      province_name: "Yên Bái",
      status: "ACTIVE",
      is_manager_decision: false,
    },
    {
      id: "topic-lao-cai",
      group_id: "group-mb03",
      message_thread_id: 102,
      topic_title: "Lào Cai Hub",
      province_name: "Lào Cai",
      status: "ACTIVE",
      is_manager_decision: false,
    },
    {
      id: "topic-phu-tho",
      group_id: "group-mb03",
      message_thread_id: 103,
      topic_title: "Phú Thọ Hub",
      province_name: "Phú Thọ",
      status: "ACTIVE",
      is_manager_decision: false,
    },
    {
      id: "topic-manager-decision",
      group_id: "group-mb03",
      message_thread_id: 999,
      topic_title: "Quyết định Manager MB03",
      province_name: null,
      status: "ACTIVE",
      is_manager_decision: true,
    },
  ];

  return {
    from: vi.fn((table: string) => {
      if (table === "telegram_pilot_topics") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn((col1: string, val1: any) => ({
              eq: vi.fn((col2: string, val2: any) => {
                let filtered = [...topics];
                if (col1 === "status") filtered = filtered.filter((t) => t.status === val1);
                if (col2 === "is_manager_decision") filtered = filtered.filter((t) => Boolean(t.is_manager_decision) === Boolean(val2));
                return Promise.resolve({ data: filtered, error: null });
              }),
            })),
          })),
        };
      }
      if (table === "telegram_pilot_groups") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn((col1: string, val1: any) => ({
              eq: vi.fn((col2: string, val2: any) => {
                let match = groups.find((g) => {
                  if (col1 === "id" && g.id !== val1) return false;
                  if (col2 === "status" && g.status !== val2) return false;
                  return true;
                });
                return {
                  maybeSingle: vi.fn().mockResolvedValue({ data: match || null, error: null }),
                };
              }),
            })),
          })),
        };
      }
      return { select: vi.fn() };
    }),
  } as any;
}

describe("Telegram Topic Routing Hardening (Part A)", () => {
  it("Criterion 1: routes Yên Bái (21161000) Lead messages to Yên Bái topic", async () => {
    const db = createMockSupabase();
    const result = await resolveWarehouseTelegramTopic(db, {
      warehouseId: "21161000",
      warehouseName: "Kho Giao Hàng Nặng - TP Yên Bái",
      role: "LEAD",
    });

    expect(result.status).toBe("ROUTED");
    if (result.status === "ROUTED") {
      expect(result.chatId).toBe("-1001234567890");
      expect(result.messageThreadId).toBe(101);
      expect(result.province).toBe("Yên Bái");
      expect(result.topicTitle).toBe("Yên Bái Hub");
      expect(result.role).toBe("LEAD");
    }
  });

  it("Criterion 2: routes Lào Cai (21158000) Lead messages to Lào Cai topic", async () => {
    const db = createMockSupabase();
    const result = await resolveWarehouseTelegramTopic(db, {
      warehouseId: "21158000",
      warehouseName: "Kho Giao Hàng Nặng - TP Lào Cai",
      role: "LEAD",
    });

    expect(result.status).toBe("ROUTED");
    if (result.status === "ROUTED") {
      expect(result.chatId).toBe("-1001234567890");
      expect(result.messageThreadId).toBe(102);
      expect(result.province).toBe("Lào Cai");
      expect(result.topicTitle).toBe("Lào Cai Hub");
    }
  });

  it("Criterion 3: routes Phú Thọ (21160000) Lead messages to Phú Thọ topic", async () => {
    const db = createMockSupabase();
    const result = await resolveWarehouseTelegramTopic(db, {
      warehouseId: "21160000",
      warehouseName: "Kho Giao Hàng Nặng - Việt Trì - Phú Thọ",
      role: "LEAD",
    });

    expect(result.status).toBe("ROUTED");
    if (result.status === "ROUTED") {
      expect(result.chatId).toBe("-1001234567890");
      expect(result.messageThreadId).toBe(103);
      expect(result.province).toBe("Phú Thọ");
      expect(result.topicTitle).toBe("Phú Thọ Hub");
    }
  });

  it("Criterion 4: routes Manager decision messages to Manager decision topic (is_manager_decision = true)", async () => {
    const db = createMockSupabase();
    const result = await resolveWarehouseTelegramTopic(db, {
      warehouseId: "21161000",
      role: "MANAGER",
    });

    expect(result.status).toBe("ROUTED");
    if (result.status === "ROUTED") {
      expect(result.chatId).toBe("-1001234567890");
      expect(result.messageThreadId).toBe(999);
      expect(result.topicTitle).toBe("Quyết định Manager MB03");
      expect(result.role).toBe("MANAGER");
    }
  });

  it("Criterion 5: fails closed with TOPIC_MAPPING_MISSING if warehouse mapping is missing", async () => {
    const db = createMockSupabase();
    const result = await resolveWarehouseTelegramTopic(db, {
      warehouseId: "99999999", // Unknown warehouse
      role: "LEAD",
    });

    expect(result.status).toBe("TOPIC_MAPPING_MISSING");
    if (result.status === "TOPIC_MAPPING_MISSING") {
      expect(result.missingField).toBe("WAREHOUSE_MAPPING");
      expect(result.reason).toContain("cannot be mapped to any known province");
      expect(result.warehouseId).toBe("99999999");
    }
  });

  it("Criterion 6: fails closed with TOPIC_MAPPING_MISSING if topic mapping is missing", async () => {
    // Database with no topics
    const db = createMockSupabase({ topics: [] });
    const result = await resolveWarehouseTelegramTopic(db, {
      warehouseId: "21161000",
      role: "LEAD",
    });

    expect(result.status).toBe("TOPIC_MAPPING_MISSING");
    if (result.status === "TOPIC_MAPPING_MISSING") {
      expect(result.missingField).toBe("TOPIC_MAPPING");
      expect(result.reason).toContain("No active warehouse topic");
    }
  });

  it("Criterion 7: never returns or falls back to General thread on routing failure", async () => {
    const db = createMockSupabase({ topics: [] });
    const result = await resolveWarehouseTelegramTopic(db, {
      warehouseId: "21161000",
      role: "LEAD",
    });

    expect(result.status).toBe("TOPIC_MAPPING_MISSING");
    expect(() => assertValidOperationalTopic(result)).toThrow(
      /TELEGRAM_ROUTING_STATUS: TOPIC_MAPPING_MISSING/
    );
  });

  it("Criterion 8: TelegramClient guards operational warehouse message against missing messageThreadId", async () => {
    const client = new TelegramClient("dummy_token", "-1001234567890");

    // Calling sendToChat with requireTopic = true and missing messageThreadId MUST reject
    await expect(
      client.sendToChat("-1001234567890", "Test operational message", {
        requireTopic: true,
      })
    ).rejects.toThrow(/TELEGRAM_ROUTING_STATUS: TOPIC_MAPPING_MISSING/);

    await expect(
      client.sendToChat("-1001234567890", "Test operational message", {
        messageThreadId: 0,
        requireTopic: true,
      })
    ).rejects.toThrow(/TELEGRAM_ROUTING_STATUS: TOPIC_MAPPING_MISSING/);
  });

  it("Criterion 9: records structured diagnostic evidence on routing failure", async () => {
    const db = createMockSupabase();
    const result = await resolveWarehouseTelegramTopic(db, {
      warehouseId: "unknown-warehouse",
      warehouseName: "Kho Không Xác Định",
      role: "LEAD",
    });

    expect(result.status).toBe("TOPIC_MAPPING_MISSING");
    if (result.status === "TOPIC_MAPPING_MISSING") {
      expect(result.diagnostic).toBeDefined();
      expect(result.diagnostic.warehouseId).toBe("unknown-warehouse");
      expect(result.diagnostic.role).toBe("LEAD");
      expect(typeof result.diagnostic.timestamp).toBe("string");
    }
  });

  it("Criterion 10: acknowledges Telegram limitation (routing isolation != visibility isolation)", () => {
    expect(TELEGRAM_ROUTING_LIMITATION_NOTE).toContain(
      "OpsPilot guarantees bot routing isolation"
    );
    expect(TELEGRAM_ROUTING_LIMITATION_NOTE).toContain(
      "never leaks to General"
    );
    expect(TELEGRAM_ROUTING_LIMITATION_NOTE).toContain(
      "Supergroup members can read topics according to Telegram group permissions"
    );
  });
});
