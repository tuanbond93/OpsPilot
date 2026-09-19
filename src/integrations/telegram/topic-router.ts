import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveProvince } from "@/notifications/gateway/scope-resolver";

export type WarehouseTopicRole = "LEAD" | "MANAGER";

export interface WarehouseTopicResolutionInput {
  warehouseId: string;
  warehouseName?: string;
  role: WarehouseTopicRole;
}

export type TopicMissingField =
  | "WAREHOUSE_MAPPING"
  | "GROUP_MAPPING"
  | "TOPIC_MAPPING"
  | "MANAGER_DECISION_TOPIC";

export interface RoutedWarehouseTopic {
  status: "ROUTED";
  chatId: string;
  messageThreadId: number;
  province: string;
  groupId: string;
  topicTitle: string;
  warehouseId: string;
  role: WarehouseTopicRole;
}

export interface TopicMappingMissing {
  status: "TOPIC_MAPPING_MISSING";
  warehouseId: string;
  warehouseName?: string;
  province: string | null;
  role: WarehouseTopicRole;
  missingField: TopicMissingField;
  reason: string;
  diagnostic: {
    warehouseId: string;
    role: WarehouseTopicRole;
    timestamp: string;
    resolvedProvince: string | null;
  };
}

export type WarehouseTopicResolutionResult =
  | RoutedWarehouseTopic
  | TopicMappingMissing;

/**
 * Normalizes province names for robust string comparison.
 */
export function normalizeProvinceName(value: string | null | undefined): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .trim()
    .toLowerCase();
}

/**
 * TELEGRAM LIMITATION NOTE:
 * Routing isolation != visibility isolation.
 *
 * In a Telegram forum supergroup, any bot message routed to a specific message_thread_id
 * will be visually organized under that forum topic. However, members who have access to
 * the supergroup can view public topics within that group unless Telegram topic permissions
 * restrict it. OpsPilot strictly enforces bot routing isolation (messages never post to General
 * or mismatched topics), but cannot alter Telegram's supergroup visibility boundaries.
 */
export const TELEGRAM_ROUTING_LIMITATION_NOTE =
  "OpsPilot guarantees bot routing isolation to the configured forum topic and never leaks to General. Supergroup members can read topics according to Telegram group permissions.";

/**
 * Resolves authoritative Telegram forum topic for a warehouse lead or manager decision.
 * Fails closed if any mapping is missing. Never returns or falls back to General (thread 0 / null).
 */
export async function resolveWarehouseTelegramTopic(
  db: SupabaseClient,
  input: WarehouseTopicResolutionInput
): Promise<WarehouseTopicResolutionResult> {
  const timestamp = new Date().toISOString();
  const { warehouseId, warehouseName, role } = input;

  if (role === "MANAGER") {
    // 1. Resolve manager decision topic (is_manager_decision = true)
    const { data: topics, error: topicError } = await db
      .from("telegram_pilot_topics")
      .select("id, group_id, message_thread_id, topic_title, province_name, status, is_manager_decision")
      .eq("status", "ACTIVE")
      .eq("is_manager_decision", true);

    if (topicError || !topics || topics.length === 0) {
      return {
        status: "TOPIC_MAPPING_MISSING",
        warehouseId,
        warehouseName,
        province: null,
        role,
        missingField: "MANAGER_DECISION_TOPIC",
        reason: "No active topic configured with is_manager_decision = true.",
        diagnostic: {
          warehouseId,
          role,
          timestamp,
          resolvedProvince: null,
        },
      };
    }

    const topic = topics[0];
    const { data: group, error: groupError } = await db
      .from("telegram_pilot_groups")
      .select("id, telegram_chat_id, status")
      .eq("id", topic.group_id)
      .eq("status", "ACTIVE")
      .maybeSingle();

    if (groupError || !group || !group.telegram_chat_id) {
      return {
        status: "TOPIC_MAPPING_MISSING",
        warehouseId,
        warehouseName,
        province: topic.province_name || null,
        role,
        missingField: "GROUP_MAPPING",
        reason: `Active group not found for manager decision topic group_id ${topic.group_id}.`,
        diagnostic: {
          warehouseId,
          role,
          timestamp,
          resolvedProvince: topic.province_name || null,
        },
      };
    }

    const threadId = Number(topic.message_thread_id);
    if (!Number.isSafeInteger(threadId) || threadId <= 0) {
      return {
        status: "TOPIC_MAPPING_MISSING",
        warehouseId,
        warehouseName,
        province: topic.province_name || null,
        role,
        missingField: "MANAGER_DECISION_TOPIC",
        reason: `Manager decision topic has invalid message_thread_id: ${topic.message_thread_id}.`,
        diagnostic: {
          warehouseId,
          role,
          timestamp,
          resolvedProvince: topic.province_name || null,
        },
      };
    }

    return {
      status: "ROUTED",
      chatId: String(group.telegram_chat_id),
      messageThreadId: threadId,
      province: topic.province_name || "Manager Decision",
      groupId: group.id,
      topicTitle: topic.topic_title,
      warehouseId,
      role,
    };
  }

  // 2. Resolve warehouse Lead topic
  const resolvedProvince = resolveProvince({
    warehouseId,
    warehouse: warehouseName,
  });

  if (!resolvedProvince) {
    return {
      status: "TOPIC_MAPPING_MISSING",
      warehouseId,
      warehouseName,
      province: null,
      role,
      missingField: "WAREHOUSE_MAPPING",
      reason: `Warehouse ID ${warehouseId} cannot be mapped to any known province.`,
      diagnostic: {
        warehouseId,
        role,
        timestamp,
        resolvedProvince: null,
      },
    };
  }

  const { data: topics, error: topicError } = await db
    .from("telegram_pilot_topics")
    .select("id, group_id, message_thread_id, topic_title, province_name, status, is_manager_decision")
    .eq("status", "ACTIVE")
    .eq("is_manager_decision", false);

  if (topicError || !topics || topics.length === 0) {
    return {
      status: "TOPIC_MAPPING_MISSING",
      warehouseId,
      warehouseName,
      province: resolvedProvince,
      role,
      missingField: "TOPIC_MAPPING",
      reason: `No active warehouse topic configured in system for province ${resolvedProvince}.`,
      diagnostic: {
        warehouseId,
        role,
        timestamp,
        resolvedProvince,
      },
    };
  }

  const targetProvinceKey = normalizeProvinceName(resolvedProvince);
  const matchingTopic = topics.find(
    (t) => normalizeProvinceName(t.province_name) === targetProvinceKey
  );

  if (!matchingTopic) {
    return {
      status: "TOPIC_MAPPING_MISSING",
      warehouseId,
      warehouseName,
      province: resolvedProvince,
      role,
      missingField: "TOPIC_MAPPING",
      reason: `No active forum topic matches province '${resolvedProvince}'. Available topics: ${topics
        .map((t) => t.province_name)
        .filter(Boolean)
        .join(", ")}.`,
      diagnostic: {
        warehouseId,
        role,
        timestamp,
        resolvedProvince,
      },
    };
  }

  const threadId = Number(matchingTopic.message_thread_id);
  if (!Number.isSafeInteger(threadId) || threadId <= 0) {
    return {
      status: "TOPIC_MAPPING_MISSING",
      warehouseId,
      warehouseName,
      province: resolvedProvince,
      role,
      missingField: "TOPIC_MAPPING",
      reason: `Topic for province '${resolvedProvince}' has invalid message_thread_id: ${matchingTopic.message_thread_id}.`,
      diagnostic: {
        warehouseId,
        role,
        timestamp,
        resolvedProvince,
      },
    };
  }

  const { data: group, error: groupError } = await db
    .from("telegram_pilot_groups")
    .select("id, telegram_chat_id, status")
    .eq("id", matchingTopic.group_id)
    .eq("status", "ACTIVE")
    .maybeSingle();

  if (groupError || !group || !group.telegram_chat_id) {
    return {
      status: "TOPIC_MAPPING_MISSING",
      warehouseId,
      warehouseName,
      province: resolvedProvince,
      role,
      missingField: "GROUP_MAPPING",
      reason: `Active group not found for topic group_id ${matchingTopic.group_id}.`,
      diagnostic: {
        warehouseId,
        role,
        timestamp,
        resolvedProvince,
      },
    };
  }

  return {
    status: "ROUTED",
    chatId: String(group.telegram_chat_id),
    messageThreadId: threadId,
    province: resolvedProvince,
    groupId: group.id,
    topicTitle: matchingTopic.topic_title,
    warehouseId,
    role,
  };
}

/**
 * Asserts that the topic resolution succeeded, otherwise throws with diagnostic details.
 */
export function assertValidOperationalTopic(
  result: WarehouseTopicResolutionResult
): asserts result is RoutedWarehouseTopic {
  if (result.status !== "ROUTED") {
    throw new Error(
      `TELEGRAM_ROUTING_STATUS: TOPIC_MAPPING_MISSING - ${result.reason} (warehouse: ${result.warehouseId}, field: ${result.missingField})`
    );
  }
}
