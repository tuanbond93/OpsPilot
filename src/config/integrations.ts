import { SecretProvider } from "../integrations/secrets";

export const INTEGRATIONS_CONFIG = {
  rillnet: {
    endpointApi: SecretProvider.getOptional("RILLNET_API_ENDPOINT", "https://rillnet-app.vercel.app/api/gtalk-send"),
    endpointMeta: SecretProvider.getOptional("RILLNET_META_ENDPOINT", "https://rillnet-app.vercel.app/wh_meta.json"),
    timeoutMs: SecretProvider.getNumber("RILLNET_TIMEOUT_MS", 10000),
    maxRetries: SecretProvider.getNumber("RILLNET_MAX_RETRIES", 3),
  },
  telegram: {
    botToken: SecretProvider.getOptional("TELEGRAM_BOT_TOKEN", "").trim(),
    chatId: SecretProvider.getOptional("TELEGRAM_CHAT_ID", "").trim(),
    timeoutMs: SecretProvider.getNumber("TELEGRAM_TIMEOUT_MS", 5000),
    maxRetries: SecretProvider.getNumber("TELEGRAM_MAX_RETRIES", 3),
  },
  realtime: {
    enabled: SecretProvider.getBoolean("REALTIME_ENABLED", true),
    channel: SecretProvider.getOptional("REALTIME_CHANNEL", "ops_updates"),
  },
  ai: {
    provider: SecretProvider.getOptional("AI_PROVIDER", "openai").toLowerCase(),
    model: SecretProvider.getOptional("AI_MODEL", "gpt-4o"),
    timeoutMs: SecretProvider.getNumber("AI_TIMEOUT_MS", 30000),
  },
};
