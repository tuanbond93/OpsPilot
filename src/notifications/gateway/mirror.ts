import { logger } from "@/observability/logger";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TelegramClient } from "../../integrations/telegram";
import type { DeliveryRequest, DeliveryResult } from "./types";

/**
 * Formats a mirror message for Manager Control Tower.
 * Shows what was sent, to whom, and delivery status.
 */
function formatOutboundMirror(
  request: DeliveryRequest,
  recipientName: string,
  deliveryResult: DeliveryResult
): string {
  const statusIcon = deliveryResult.status === "SUCCESS" ? "✅" : deliveryResult.status === "FAILED" ? "❌" : "⏳";
  const warehouse = request.audience.warehouse || "N/A";
  const province = request.audience.province || "N/A";
  const sentAt = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

  const preview = request.message.length > 300
    ? request.message.slice(0, 297) + "…"
    : request.message;

  return [
    `🔵 <b>OUTGOING</b>`,
    `Đã gửi → <b>${escapeTelegramHtml(recipientName)}</b>`,
    ``,
    `Kho: ${escapeTelegramHtml(warehouse)}`,
    `Tỉnh: ${escapeTelegramHtml(province)}`,
    request.incidentKey ? `Case: ${escapeTelegramHtml(request.incidentKey)}` : null,
    request.workOrderId ? `Work Order: ${request.workOrderId.slice(0, 8)}` : null,
    ``,
    `${escapeTelegramHtml(request.eventType)}`,
    `<blockquote>${escapeTelegramHtml(preview)}</blockquote>`,
    ``,
    `Sent: ${sentAt}`,
    `Status: ${statusIcon} ${deliveryResult.status}`,
    deliveryResult.error ? `Error: ${escapeTelegramHtml(deliveryResult.error.slice(0, 200))}` : null,
  ].filter(Boolean).join("\n");
}

/**
 * Formats an inbound reply mirror message.
 */
export function formatInboundMirror(
  senderName: string,
  replyText: string,
  incidentKey: string | null,
  warehouseName: string | null
): string {
  return [
    `🟢 <b>REPLY</b>`,
    `${escapeTelegramHtml(senderName)} → OpsPilot`,
    ``,
    incidentKey ? `Case: ${escapeTelegramHtml(incidentKey)}` : null,
    warehouseName ? `Kho: ${escapeTelegramHtml(warehouseName)}` : null,
    ``,
    `<blockquote>${escapeTelegramHtml(replyText.slice(0, 500))}</blockquote>`,
    ``,
    `Received: ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`,
  ].filter(Boolean).join("\n");
}

/**
 * Formats an AI analysis mirror message.
 */
export function formatAnalysisMirror(
  analysis: {
    classification?: string | null;
    cause?: string | null;
    commitment?: string | null;
    nextCheck?: string | null;
    action?: string | null;
  }
): string {
  return [
    `🤖 <b>OPSPILOT ANALYSIS</b>`,
    ``,
    analysis.classification ? `Classification: <b>${escapeTelegramHtml(analysis.classification)}</b>` : null,
    analysis.cause ? `Cause: ${escapeTelegramHtml(analysis.cause)}` : null,
    analysis.commitment ? `Commitment: ${escapeTelegramHtml(analysis.commitment)}` : null,
    analysis.nextCheck ? `Next check: ${escapeTelegramHtml(analysis.nextCheck)}` : null,
    analysis.action ? `Action: <b>${escapeTelegramHtml(analysis.action)}</b>` : null,
  ].filter(Boolean).join("\n");
}

function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface MirrorTarget {
  chatId: string;
  messageThreadId?: number | null;
}

export interface MirrorResult {
  ok: boolean;
  telegramMessageId?: string;
  error?: string;
}

/**
 * Manager Control Tower Mirror Service.
 *
 * CRITICAL RULES:
 * 1. Mirror is OBSERVER ONLY — never affects business state.
 * 2. Mirror failures NEVER block or rollback employee delivery.
 * 3. Mirror failures are logged but not thrown.
 */
export class ManagerMirrorService {
  private client: TelegramClient;

  constructor(telegramClient?: TelegramClient) {
    this.client = telegramClient || new TelegramClient();
  }

  /**
   * Sends outbound mirror to Control Tower topic.
   * If mirror fails, logs the error and returns failure result.
   * NEVER throws — employee delivery is already done.
   */
  async mirrorOutbound(
    request: DeliveryRequest,
    recipientName: string,
    deliveryResult: DeliveryResult,
    target: MirrorTarget,
    dbClient?: SupabaseClient
  ): Promise<MirrorResult> {
    try {
      const mirrorText = formatOutboundMirror(request, recipientName, deliveryResult);
      const result = await this.client.sendToChat(target.chatId, mirrorText, {
        parseMode: "HTML",
        messageThreadId: target.messageThreadId ?? undefined,
      });

      // Audit mirror delivery if DB client available
      if (dbClient) {
        await this.recordMirrorDelivery(dbClient, request, "OUTBOUND_MIRROR", "SUCCESS", result.messageId, target);
      }

      return { ok: true, telegramMessageId: result.messageId };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({
        category: "MIRROR_FAILED",
        direction: "outbound",
        incidentId: request.incidentId,
        eventType: request.eventType,
        error: errorMsg.slice(0, 500),
        occurredAt: new Date().toISOString(),
      });

      if (dbClient) {
        await this.recordMirrorDelivery(dbClient, request, "OUTBOUND_MIRROR", "FAILED", null, target, errorMsg).catch(() => {});
      }

      return { ok: false, error: errorMsg };
    }
  }

  /**
   * Sends inbound reply mirror to Control Tower topic.
   */
  async mirrorInbound(
    senderName: string,
    replyText: string,
    incidentKey: string | null,
    warehouseName: string | null,
    target: MirrorTarget,
    dbClient?: SupabaseClient,
    metadata?: Record<string, unknown>
  ): Promise<MirrorResult> {
    try {
      const mirrorText = formatInboundMirror(senderName, replyText, incidentKey, warehouseName);
      const result = await this.client.sendToChat(target.chatId, mirrorText, {
        parseMode: "HTML",
        messageThreadId: target.messageThreadId ?? undefined,
      });

      if (dbClient) {
        await dbClient.from("message_deliveries").insert({
          incident_key: incidentKey,
          event_type: "INBOUND_MIRROR",
          direction: "SYSTEM",
          destination_type: "MIRROR",
          recipient_chat_id: target.chatId,
          telegram_thread_id: target.messageThreadId,
          telegram_message_id: Number(result.messageId) || null,
          message_preview: replyText.slice(0, 500),
          delivery_status: "SUCCESS",
          routing_mode: "MIRROR",
          routing_reason: "manager_control_tower",
          sent_at: new Date().toISOString(),
          ...(metadata || {}),
        });
        // Ignore audit write errors for mirror
      }

      return { ok: true, telegramMessageId: result.messageId };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({
        category: "MIRROR_FAILED",
        direction: "inbound",
        incidentKey,
        error: errorMsg.slice(0, 500),
        occurredAt: new Date().toISOString(),
      });
      return { ok: false, error: errorMsg };
    }
  }

  /**
   * Sends AI analysis mirror to Control Tower topic.
   */
  async mirrorAnalysis(
    analysis: {
      classification?: string | null;
      cause?: string | null;
      commitment?: string | null;
      nextCheck?: string | null;
      action?: string | null;
    },
    target: MirrorTarget,
  ): Promise<MirrorResult> {
    try {
      const mirrorText = formatAnalysisMirror(analysis);
      const result = await this.client.sendToChat(target.chatId, mirrorText, {
        parseMode: "HTML",
        messageThreadId: target.messageThreadId ?? undefined,
      });
      return { ok: true, telegramMessageId: result.messageId };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({
        category: "MIRROR_FAILED",
        direction: "analysis",
        error: errorMsg.slice(0, 500),
        occurredAt: new Date().toISOString(),
      });
      return { ok: false, error: errorMsg };
    }
  }

  /**
   * Resolves the mirror target for a given province.
   * Uses existing telegram_pilot_topics to find the province topic.
   */
  async resolveMirrorTarget(
    client: SupabaseClient,
    province: string | null
  ): Promise<MirrorTarget | null> {
    if (!province) return null;

    const normalizedProvince = province
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/gi, "d")
      .trim()
      .toLocaleLowerCase("vi");

    // Query active topics with province mapping
    const { data: topics, error } = await client
      .from("telegram_pilot_topics")
      .select("id, group_id, message_thread_id, province_name, telegram_pilot_groups!inner(telegram_chat_id, status)")
      .eq("status", "ACTIVE")
      .not("province_name", "is", null);

    if (error || !topics?.length) return null;

    // Find matching topic by normalized province name
    const match = topics.find((topic: any) => {
      const topicProvince = String(topic.province_name || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/gi, "d")
        .trim()
        .toLocaleLowerCase("vi");
      return topicProvince === normalizedProvince;
    });

    if (!match) return null;

    const group = (match as any).telegram_pilot_groups;
    if (!group || group.status !== "ACTIVE") return null;

    return {
      chatId: String(group.telegram_chat_id),
      messageThreadId: match.message_thread_id,
    };
  }

  private async recordMirrorDelivery(
    client: SupabaseClient,
    request: DeliveryRequest,
    eventType: string,
    status: string,
    telegramMessageId: string | null,
    target: MirrorTarget,
    error?: string
  ): Promise<void> {
    await client.from("message_deliveries").insert({
      incident_id: request.incidentId,
      incident_key: request.incidentKey,
      followup_case_id: request.followupCaseId,
      work_order_id: request.workOrderId,
      event_type: eventType,
      direction: "SYSTEM",
      destination_type: "MIRROR",
      recipient_chat_id: target.chatId,
      telegram_thread_id: target.messageThreadId,
      telegram_message_id: telegramMessageId ? Number(telegramMessageId) : null,
      message_preview: request.message.slice(0, 500),
      delivery_status: status,
      error_message: error?.slice(0, 1000),
      routing_mode: "MIRROR",
      routing_reason: "manager_control_tower",
      sent_at: status === "SUCCESS" ? new Date().toISOString() : null,
    });
    // Ignore audit write errors for mirror
  }
}
