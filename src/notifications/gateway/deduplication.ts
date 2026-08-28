import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeliveryRequest } from "./types";

/**
 * Generates a deterministic idempotency key for a delivery request.
 * Extends the existing pattern from telegram_followup_reminders.idempotency_key
 */
export function buildIdempotencyKey(request: DeliveryRequest): string {
  const parts: string[] = ["gateway"];
  
  if (request.followupCaseId) {
    // Match existing pattern: telegram-followup:{caseId}:{stage}
    return `telegram-followup:${request.followupCaseId}:${request.eventType}`;
  }
  
  if (request.workOrderId && request.audience.groupId) {
    // Match existing pattern: telegram-dispatch:{workOrderId}:{groupId}
    return `telegram-dispatch:${request.workOrderId}:${request.audience.groupId}`;
  }
  
  // Generic gateway key
  if (request.incidentId) parts.push(request.incidentId);
  if (request.incidentKey) parts.push(request.incidentKey);
  parts.push(request.eventType);
  if (request.audience.recipientMemberIds?.length) {
    parts.push(request.audience.recipientMemberIds.sort().join(","));
  }
  
  return parts.join(":");
}

export interface DeduplicationResult {
  isDuplicate: boolean;
  existingDeliveryId?: string;
  existingStatus?: string;
}

/**
 * Checks if a delivery request has already been processed.
 * Returns the existing delivery if found and successful/pending.
 */
export async function checkDuplicate(
  client: SupabaseClient,
  idempotencyKey: string
): Promise<DeduplicationResult> {
  const { data, error } = await client
    .from("message_deliveries")
    .select("id, delivery_status")
    .eq("idempotency_key", idempotencyKey)
    .in("delivery_status", ["SUCCESS", "PENDING"])
    .maybeSingle();
  
  if (error || !data) {
    return { isDuplicate: false };
  }
  
  return {
    isDuplicate: true,
    existingDeliveryId: data.id,
    existingStatus: data.delivery_status,
  };
}
