import type { NotificationProvider, SendResult, ProviderHealth } from "./provider";
import type { NotificationActionRow } from "../../engine/action-queue";
import { TelegramClient } from "../../integrations/telegram";

export class TelegramProvider implements NotificationProvider {
  private client: TelegramClient;
  private botToken?: string;
  private chatId?: string;

  constructor(botToken?: string, chatId?: string) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.client = new TelegramClient(botToken, chatId);
  }

  name(): string {
    return "telegram";
  }

  async send(action: NotificationActionRow, formattedMessage?: string): Promise<SendResult> {
    const messageText = formattedMessage || String(action.payload?.rootCauseSummary || "Notification alert");

    const token = this.botToken || process.env.TELEGRAM_BOT_TOKEN;
    const chat = this.chatId || process.env.TELEGRAM_CHAT_ID;
    const isConfigured = !!(token && chat);

    if (!isConfigured) {
      // Dry-run / Simulation mode when environment variables are unconfigured
      return {
        outcome: "SIMULATED",
        providerMessageId: `tg-sim-${Date.now()}`,
        response: {
          provider: "telegram",
          mode: "mock_dry_run",
          simulatedAt: new Date().toISOString(),
          messageLength: messageText.length,
          note: "Simulation mode active (TELEGRAM_BOT_TOKEN environment variable not set)",
        },
      };
    }

    try {
      const outcome = await this.client.sendMessage(messageText);
      return {
        outcome: "DELIVERED",
        providerMessageId: outcome.messageId,
        response: outcome.response,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit = msg.includes("Rate limited") || msg.includes("429");
      return {
        outcome: "FAILED",
        errorCode: isRateLimit ? "RATE_LIMIT_EXCEEDED" : "NETWORK_TIMEOUT",
        error: `Telegram HTTP request failed: ${msg}`,
        retryAfterSeconds: isRateLimit ? 30 : undefined,
      };
    }
  }

  async health(): Promise<ProviderHealth> {
    const healthInfo = await this.client.health();
    if (healthInfo.status === "GREEN") {
      return {
        name: "telegram",
        status: "Healthy",
        latencyMs: 150,
        details: healthInfo.healthReason,
      };
    }

    if (healthInfo.status === "UNKNOWN") {
      return {
        name: "telegram",
        status: "Offline",
        details: healthInfo.healthReason,
      };
    }

    return {
      name: "telegram",
      status: "Degraded",
      latencyMs: 0,
      details: healthInfo.healthReason,
    };
  }
}
