export type EventType =
  | "FIRST_PUSH"
  | "SECOND_PUSH"
  | "THIRD_PUSH"
  | "ESCALATION"
  | "WORK_ORDER_DISPATCH"
  | "WORK_ORDER_REMINDER"
  | "ROOTCAUSE_SUMMARY"
  | "CONFIRMATION"
  | "SYSTEM";

export type DestinationType = "GROUP_TOPIC" | "PRIVATE_DM" | "MIRROR";
export type DeliveryStatus = "PENDING" | "SUCCESS" | "FAILED" | "FALLBACK" | "SKIPPED" | "SIMULATED";
export type Direction = "OUTBOUND" | "INBOUND" | "SYSTEM";

export interface DeliveryAudience {
  province?: string | null;
  provinceCode?: string | null;
  warehouse?: string | null;
  warehouseId?: string | null;
  region?: string | null;
  recipientMemberIds?: string[];
  groupId?: string | null;
  chatId?: string | null;
  messageThreadId?: number | null;
}

export interface DeliveryRequest {
  eventType: EventType;
  incidentId?: string | null;
  incidentKey?: string | null;
  followupCaseId?: string | null;
  workOrderId?: string | null;
  dispatchId?: string | null;
  message: string;
  audience: DeliveryAudience;
  metadata?: Record<string, unknown>;
  options?: {
    parseMode?: "HTML" | "MarkdownV2";
    inlineKeyboard?: Array<Array<{ text: string; callbackData: string }>>;
    idempotencyKey?: string;
    actor?: string;
    /** Disable per-delivery Telegram mirror when the caller emits one batch summary. */
    mirror?: boolean;
  };
}

export interface DeliveryResult {
  deliveryId: string;
  status: DeliveryStatus;
  destination: DestinationType;
  telegramMessageId?: string | null;
  chatId?: string | null;
  messageThreadId?: number | null;
  error?: string | null;
  errorCode?: string | null;
  routingMode: string;
  routingReason: string;
  mirrorResult?: DeliveryResult | null;
}

export interface RoutingDecision {
  mode: import("../../config/feature-flags").RoutingMode;
  destination: DestinationType;
  chatId: string;
  messageThreadId?: number | null;
  recipientUserIds?: string[];
  reason: string;
  fallbackDestination?: {
    destination: DestinationType;
    chatId: string;
    messageThreadId?: number | null;
  } | null;
}
