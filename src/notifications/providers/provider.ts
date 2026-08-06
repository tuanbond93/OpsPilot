import type { NotificationActionRow, DeliveryOutcome } from "../../engine/action-queue";

export type { DeliveryOutcome };

export interface SendResult {
  outcome: DeliveryOutcome;
  providerMessageId?: string;
  response?: Record<string, unknown>;
  error?: string;
  errorCode?: string;
  retryAfterSeconds?: number;
}

export interface ProviderHealth {
  name: string;
  status: "Healthy" | "Degraded" | "Offline";
  latencyMs?: number;
  details?: string;
}

export interface NotificationProvider {
  name(): string;
  send(action: NotificationActionRow, formattedMessage?: string): Promise<SendResult>;
  health(): Promise<ProviderHealth>;
}
