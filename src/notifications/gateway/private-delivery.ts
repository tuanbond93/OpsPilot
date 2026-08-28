import { logger } from "@/observability/logger";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TelegramClient } from "../../integrations/telegram";
import type { DeliveryRequest, DeliveryResult } from "./types";

export type OnboardingState = "PRIVATE_READY" | "PRIVATE_NOT_STARTED" | "DISABLED" | "BLOCKED" | "UNKNOWN";

export interface PrivateRecipient {
  memberId: string;
  privateChatId: number;
  displayName: string;
  onboardingState: OnboardingState;
}

export interface PrivateDeliveryResult {
  delivered: DeliveryResult[];
  fallback: DeliveryResult[];
  failed: DeliveryResult[];
}

/**
 * Delivers notifications via private (DM) chat with the OpsPilot bot.
 *
 * IMPORTANT:
 * - Telegram bot can only send private messages if user has /start-ed the bot.
 * - Checks onboarding_state === PRIVATE_READY before attempting DM.
 * - If user not ready, falls back safely per policy (legacy group or manager alert).
 * - Authorization must happen BEFORE this provider is called.
 */
export class PrivateDeliveryProvider {
  private client: TelegramClient;

  constructor(telegramClient?: TelegramClient) {
    this.client = telegramClient || new TelegramClient();
  }

  /**
   * Delivers a message to a single private recipient.
   * Only attempts delivery if recipient is PRIVATE_READY.
   */
  async deliverToRecipient(
    request: DeliveryRequest,
    recipient: PrivateRecipient
  ): Promise<DeliveryResult> {
    const deliveryId = `private-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (recipient.onboardingState !== "PRIVATE_READY") {
      return {
        deliveryId,
        status: "SKIPPED",
        destination: "PRIVATE_DM",
        chatId: null,
        error: `User not ready for private delivery: ${recipient.onboardingState}`,
        errorCode: "USER_NOT_STARTED",
        routingMode: "PRIVATE",
        routingReason: `onboarding_state=${recipient.onboardingState}`,
      };
    }

    try {
      const result = await this.client.sendToChat(
        String(recipient.privateChatId),
        request.message,
        {
          parseMode: request.options?.parseMode,
          inlineKeyboard: request.options?.inlineKeyboard,
        }
      );

      return {
        deliveryId,
        status: "SUCCESS",
        destination: "PRIVATE_DM",
        telegramMessageId: result.messageId,
        chatId: String(recipient.privateChatId),
        routingMode: "PRIVATE",
        routingReason: "private_dm_delivered",
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isBotBlocked = errorMsg.includes("bot was blocked") || errorMsg.includes("Forbidden");
      const isChatNotFound = errorMsg.includes("chat not found");

      // If bot blocked, update onboarding state
      if (isBotBlocked) {
        logger.warn({
          category: "PRIVATE_DELIVERY_BLOCKED",
          memberId: recipient.memberId,
          error: errorMsg.slice(0, 200),
          occurredAt: new Date().toISOString(),
        });
      }

      return {
        deliveryId,
        status: "FAILED",
        destination: "PRIVATE_DM",
        chatId: String(recipient.privateChatId),
        error: errorMsg,
        errorCode: isBotBlocked ? "BOT_BLOCKED" : isChatNotFound ? "CHAT_NOT_FOUND" : "SEND_FAILED",
        routingMode: "PRIVATE",
        routingReason: "private_dm_failed",
      };
    }
  }

  /**
   * Delivers to multiple private recipients with fallback handling.
   * For each recipient:
   * - PRIVATE_READY → attempt DM
   * - NOT READY → add to fallback list
   * - DM FAILED → add to failed list
   */
  async deliverToRecipients(
    request: DeliveryRequest,
    recipients: PrivateRecipient[],
  ): Promise<PrivateDeliveryResult> {
    const result: PrivateDeliveryResult = {
      delivered: [],
      fallback: [],
      failed: [],
    };

    for (const recipient of recipients) {
      if (recipient.onboardingState !== "PRIVATE_READY") {
        result.fallback.push({
          deliveryId: `fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          status: "FALLBACK",
          destination: "PRIVATE_DM",
          chatId: null,
          error: `User not ready: ${recipient.onboardingState}`,
          errorCode: "USER_NOT_STARTED",
          routingMode: "PRIVATE_WITH_FALLBACK",
          routingReason: `onboarding_state=${recipient.onboardingState}`,
        });
        continue;
      }

      const deliveryResult = await this.deliverToRecipient(request, recipient);

      if (deliveryResult.status === "SUCCESS") {
        result.delivered.push(deliveryResult);
      } else {
        result.failed.push(deliveryResult);
      }
    }

    return result;
  }

  /**
   * Records /start from a user — sets them as PRIVATE_READY.
   */
  static async handleBotStart(
    client: SupabaseClient,
    telegramUserId: number,
    chatId: number,
    displayName: string
  ): Promise<{ memberId: string | null; isNewRegistration: boolean }> {
    // Find existing member by telegram_user_id
    const { data: member, error: findError } = await client
      .from("telegram_pilot_members")
      .select("id, onboarding_state, private_chat_id")
      .eq("telegram_user_id", telegramUserId)
      .maybeSingle();

    if (findError) throw findError;

    if (!member) {
      // User not in roster — they need to /join a group first
      return { memberId: null, isNewRegistration: false };
    }

    // Update private chat info
    const { error: updateError } = await client
      .from("telegram_pilot_members")
      .update({
        private_chat_id: chatId,
        onboarding_state: "PRIVATE_READY",
        last_seen_at: new Date().toISOString(),
      })
      .eq("id", member.id);

    if (updateError) throw updateError;

    return {
      memberId: member.id,
      isNewRegistration: member.onboarding_state !== "PRIVATE_READY",
    };
  }

  /**
   * Updates onboarding state when bot is blocked by user.
   */
  static async handleBotBlocked(
    client: SupabaseClient,
    telegramUserId: number
  ): Promise<void> {
    await client
      .from("telegram_pilot_members")
      .update({
        onboarding_state: "BLOCKED",
        last_seen_at: new Date().toISOString(),
      })
      .eq("telegram_user_id", telegramUserId);
  }
}
