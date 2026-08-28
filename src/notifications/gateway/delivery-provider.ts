import { TelegramClient } from "../../integrations/telegram";
import type { DeliveryRequest, DeliveryResult, DestinationType } from "./types";

/**
 * Wraps TelegramClient.sendToChat() with structured input/output.
 * This is the single point where Telegram API calls happen for outbound messages.
 */
export class TelegramDeliveryProvider {
  private client: TelegramClient;
  
  constructor(client?: TelegramClient) {
    this.client = client || new TelegramClient();
  }
  
  async deliver(
    request: DeliveryRequest,
    chatId: string,
    destination: DestinationType,
    messageThreadId?: number | null,
  ): Promise<DeliveryResult> {
    const deliveryId = `delivery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    try {
      const result = await this.client.sendToChat(chatId, request.message, {
        parseMode: request.options?.parseMode,
        inlineKeyboard: request.options?.inlineKeyboard,
        messageThreadId: messageThreadId ?? undefined,
      });
      
      return {
        deliveryId,
        status: "SUCCESS",
        destination,
        telegramMessageId: result.messageId,
        chatId,
        messageThreadId: messageThreadId ?? null,
        routingMode: "LEGACY",
        routingReason: "direct_delivery",
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isRateLimit = errorMsg.includes("429") || errorMsg.includes("Rate limited");
      const isBotBlocked = errorMsg.includes("bot was blocked") || errorMsg.includes("Forbidden");
      const isChatNotFound = errorMsg.includes("chat not found") || errorMsg.includes("400");
      
      return {
        deliveryId,
        status: "FAILED",
        destination,
        chatId,
        messageThreadId: messageThreadId ?? null,
        error: errorMsg,
        errorCode: isRateLimit ? "RATE_LIMIT" : isBotBlocked ? "BOT_BLOCKED" : isChatNotFound ? "CHAT_NOT_FOUND" : "SEND_FAILED",
        routingMode: "LEGACY",
        routingReason: "direct_delivery",
      };
    }
  }
}
