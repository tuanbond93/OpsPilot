/**
 * Manager Attention Service
 *
 * Filters events to identify cases that NEED MANAGER ATTENTION
 * vs routine AUDIT/LIVE FEED messages.
 *
 * Prevents Control Tower from becoming spam by separating:
 * 1. AUDIT / LIVE FEED — all messages (mirror)
 * 2. NEEDS MANAGER ATTENTION — urgent cases only
 */

export type AttentionReason =
  | "NO_RESPONSE_AFTER_SLA"
  | "ESCALATION_REQUIRED"
  | "EXPLANATION_INVALID"
  | "EXPLANATION_MISSING_ETA"
  | "ETA_MISSED"
  | "REPEATED_BACKLOG"
  | "SCOPE_ROUTING_FAILURE"
  | "USER_UNAUTHORIZED"
  | "DM_DELIVERY_FAILED"
  | "SUSPICIOUS_AI_CLASSIFICATION"
  | "REVIEW_REQUIRED"
  | "CASE_UNRESOLVABLE";

export interface AttentionEvent {
  reason: AttentionReason;
  incidentId?: string | null;
  incidentKey?: string | null;
  province?: string | null;
  warehouse?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}

const ATTENTION_EMOJI: Record<AttentionReason, string> = {
  NO_RESPONSE_AFTER_SLA: "⏰",
  ESCALATION_REQUIRED: "🚨",
  EXPLANATION_INVALID: "❌",
  EXPLANATION_MISSING_ETA: "⚠️",
  ETA_MISSED: "🕐",
  REPEATED_BACKLOG: "🔄",
  SCOPE_ROUTING_FAILURE: "🔀",
  USER_UNAUTHORIZED: "🔒",
  DM_DELIVERY_FAILED: "📭",
  SUSPICIOUS_AI_CLASSIFICATION: "🤖",
  REVIEW_REQUIRED: "👀",
  CASE_UNRESOLVABLE: "❓",
};

/**
 * Formats an attention message for Manager Control Tower.
 * Short, operational, easy to scan.
 */
export function formatAttentionMessage(event: AttentionEvent): string {
  const emoji = ATTENTION_EMOJI[event.reason] || "⚠️";
  const lines: string[] = [
    `${emoji} <b>NEEDS ATTENTION</b>`,
    ``,
    `Reason: <b>${escapeTelegramHtml(event.reason.replace(/_/g, " "))}</b>`,
  ];

  if (event.incidentKey) lines.push(`Case: ${escapeTelegramHtml(event.incidentKey)}`);
  if (event.warehouse) lines.push(`Kho: ${escapeTelegramHtml(event.warehouse)}`);
  if (event.province) lines.push(`Tỉnh: ${escapeTelegramHtml(event.province)}`);
  lines.push(``);
  lines.push(escapeTelegramHtml(event.summary));

  return lines.join("\n");
}

/**
 * Determines if a delivery failure requires manager attention.
 */
export function isDeliveryFailureAttentionWorthy(
  errorCode: string | null | undefined,
  retryCount: number
): boolean {
  // Permanent failures always need attention
  const permanentErrors = ["BOT_BLOCKED", "CHAT_NOT_FOUND", "USER_NOT_STARTED"];
  if (errorCode && permanentErrors.includes(errorCode)) return true;

  // Transient failures only after multiple retries
  if (retryCount >= 3) return true;

  return false;
}

/**
 * Determines if a routing failure requires manager attention.
 */
export function isRoutingFailureAttentionWorthy(
  quarantine: boolean,
  quarantineReason?: string
): boolean {
  // All quarantined events need attention
  return quarantine;
}

/**
 * Determines if an AI classification is suspicious and needs review.
 */
export function isSuspiciousClassification(
  classification: string | null | undefined,
  confidence?: number | null
): boolean {
  if (!classification) return false;

  // Low confidence classifications
  if (confidence != null && confidence < 0.5) return true;

  // Specific classifications that need human review
  const suspiciousClassifications = ["UNCLEAR", "CONFLICTING", "POTENTIALLY_FALSE"];
  return suspiciousClassifications.includes(classification);
}

function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
