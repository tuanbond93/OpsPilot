import type { ComponentHealth, HealthCheckable } from "../health";
import { SecretProvider } from "../secrets";

type InlineKeyboardButton =
  | { text: string; callbackData: string; copyText?: never }
  | { text: string; copyText: string; callbackData?: never };

export class TelegramClient implements HealthCheckable {
  readonly name = "Telegram";
  private lastSuccessAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastErrorReason: string | null = null;

  private botToken: string;
  private chatId: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(botToken?: string, chatId?: string) {
    this.botToken = (botToken || SecretProvider.getOptional("TELEGRAM_BOT_TOKEN", "")).trim();
    this.chatId = (chatId || SecretProvider.getOptional("TELEGRAM_CHAT_ID", "")).trim();
    this.timeoutMs = SecretProvider.getNumber("TELEGRAM_TIMEOUT_MS", 5000); // 5s timeout
    this.maxRetries = SecretProvider.getNumber("TELEGRAM_MAX_RETRIES", 3);
  }

  /**
   * Escape markdown reserved characters for Telegram Markdown format V1
   */
  escapeMarkdown(text: string): string {
    // Escapes common markdown characters that might break Telegram V1 parsing
    return text
      .replace(/_/g, "\\_")
      .replace(/\*/g, "\\*")
      .replace(/\[/g, "\\[")
      .replace(/`/g, "\\`")
      .replace(/#/g, "\\#");
  }

  /**
   * Sends text message to Telegram channel/chat with automatic retries and 429 rate-limiting handling
   */
  async sendMessage(text: string): Promise<{ messageId: string; response: any }> {
    if (!this.botToken || !this.chatId) {
      // Unconfigured behaves as dry-run simulation
      return {
        messageId: `tg-sim-${Date.now()}`,
        response: { simulated: true, note: "Unconfigured bot token/chat id" },
      };
    }

    return this.sendToChat(this.chatId, text);
  }

  /** Sends an operational message to a mapped pilot group. Never falls back to a default chat. */
  async sendToChat(
    chatId: string,
    text: string,
    options: { inlineKeyboard?: InlineKeyboardButton[][]; parseMode?: "HTML" | "MarkdownV2"; messageThreadId?: number | null } = {}
  ): Promise<{ messageId: string; response: any }> {
    if (!this.botToken) throw new Error("Telegram bot token is not configured.");
    if (!chatId.trim()) throw new Error("Telegram pilot group is not configured.");
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    let delay = 1000;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
            ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
            ...(Number.isSafeInteger(options.messageThreadId) && Number(options.messageThreadId) > 0 ? { message_thread_id: options.messageThreadId } : {}),
            ...(options.inlineKeyboard ? { reply_markup: { inline_keyboard: options.inlineKeyboard.map((row) => row.map((button) => button.copyText
              ? { text: button.text, copy_text: { text: button.copyText } }
              : { text: button.text, callback_data: button.callbackData })) } } : {}),
          }),
          signal: controller.signal,
        });

        clearTimeout(id);
        const json = await res.json();

        // Check for 429 rate limit
        if (res.status === 429) {
          const retryAfter = json.parameters?.retry_after || 10;
          this.lastFailureAt = new Date().toISOString();
          this.lastErrorReason = `Rate limited: retry after ${retryAfter} seconds`;

          // Sleep for retry_after seconds and continue the loop to retry
          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
          continue;
        }

        if (!res.ok || !json.ok) {
          throw new Error(json.description || `Telegram API returned status ${res.status}`);
        }

        this.lastSuccessAt = new Date().toISOString();
        return {
          messageId: String(json.result?.message_id || `tg-${Date.now()}`),
          response: json,
        };
      } catch (err: any) {
        clearTimeout(id);
        this.lastFailureAt = new Date().toISOString();
        this.lastErrorReason = err?.message || String(err);

        if (attempt === this.maxRetries) {
          throw err;
        }

        // Exponential backoff
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }

    throw new Error(`Telegram sendMessage failed after ${this.maxRetries} attempts.`);
  }

  /**
   * Health Check Implementation
   */
  async health(): Promise<ComponentHealth> {
    if (!this.botToken) {
      return {
        status: "UNKNOWN",
        healthReason: "Telegram bot is not configured (missing botToken)",
        lastSuccessAt: this.lastSuccessAt,
        lastFailureAt: this.lastFailureAt,
        freshnessSeconds: null,
      };
    }

    try {
      const startMs = Date.now();
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 3000);

      const url = `https://api.telegram.org/bot${this.botToken}/getMe`;
      const res = await fetch(url, { method: "GET", signal: controller.signal });
      clearTimeout(id);

      const latencyMs = Date.now() - startMs;

      if (res.ok) {
        this.lastSuccessAt = new Date().toISOString();
        return {
          status: "GREEN",
          healthReason: this.chatId
            ? `Telegram bot is online (Latency: ${latencyMs}ms)`
            : `Telegram bot is online for mapped pilot groups; default chat is not configured (Latency: ${latencyMs}ms)`,
          lastSuccessAt: this.lastSuccessAt,
          lastFailureAt: this.lastFailureAt,
          freshnessSeconds: 0,
        };
      }

      throw new Error(`Telegram getMe returned HTTP ${res.status}`);
    } catch (err: any) {
      this.lastFailureAt = new Date().toISOString();
      this.lastErrorReason = err?.message || String(err);
      return {
        status: "RED",
        healthReason: `Telegram API check failed: ${this.lastErrorReason}`,
        lastSuccessAt: this.lastSuccessAt,
        lastFailureAt: this.lastFailureAt,
        freshnessSeconds: this.lastSuccessAt
          ? Math.round((Date.now() - new Date(this.lastSuccessAt).getTime()) / 1000)
          : null,
      };
    }
  }
}
