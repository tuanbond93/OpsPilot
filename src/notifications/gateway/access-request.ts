import type { SupabaseClient } from "@supabase/supabase-js";

export interface CreateAccessRequestInput {
  memberId: string;
  telegramUserId: number;
  displayName: string;
  requestedScopeType: "WAREHOUSE" | "PROVINCE" | "REGION" | "ALL";
  requestedScopeCode: string;
}

export interface AccessRequestResult {
  ok: boolean;
  requestId?: string;
  message: string;
}

/**
 * Creates an access request from a /join command.
 * Users CANNOT self-grant permissions.
 */
export async function createAccessRequest(
  client: SupabaseClient,
  input: CreateAccessRequestInput,
  actor: string = "telegram_join"
): Promise<AccessRequestResult> {
  // Check for existing pending request
  const { data: existing, error: existingError } = await client
    .from("telegram_access_requests")
    .select("id, status")
    .eq("member_id", input.memberId)
    .eq("requested_scope_type", input.requestedScopeType)
    .eq("requested_scope_code", input.requestedScopeCode)
    .eq("status", "PENDING")
    .maybeSingle();
  
  if (existingError) throw existingError;
  if (existing) {
    return { ok: true, requestId: existing.id, message: "Access request already pending" };
  }
  
  const { data: request, error: insertError } = await client
    .from("telegram_access_requests")
    .insert({
      member_id: input.memberId,
      telegram_user_id: input.telegramUserId,
      display_name: input.displayName,
      requested_scope_type: input.requestedScopeType,
      requested_scope_code: input.requestedScopeCode,
      status: "PENDING",
    })
    .select("id")
    .single();
  
  if (insertError) throw insertError;
  
  // Record audit event
  await client.from("telegram_access_request_events").insert({
    request_id: request.id,
    event_type: "REQUEST_CREATED",
    actor,
    metadata: {
      telegramUserId: input.telegramUserId,
      displayName: input.displayName,
      scopeType: input.requestedScopeType,
      scopeCode: input.requestedScopeCode,
    },
  });
  
  return { ok: true, requestId: request.id, message: "Access request created" };
}

/**
 * Approves an access request and creates the corresponding scope.
 */
export async function approveAccessRequest(
  client: SupabaseClient,
  requestId: string,
  approvedBy: string,
  notes?: string
): Promise<AccessRequestResult> {
  const { data: request, error: fetchError } = await client
    .from("telegram_access_requests")
    .select("*")
    .eq("id", requestId)
    .eq("status", "PENDING")
    .maybeSingle();
  
  if (fetchError) throw fetchError;
  if (!request) return { ok: false, message: "Request not found or already processed" };
  
  const now = new Date().toISOString();
  
  // Update request status
  const { error: updateError } = await client
    .from("telegram_access_requests")
    .update({
      status: "APPROVED",
      reviewed_by: approvedBy,
      reviewed_at: now,
      review_notes: notes || null,
      updated_at: now,
    })
    .eq("id", requestId);
  
  if (updateError) throw updateError;
  
  // Create scope
  const { error: scopeError } = await client
    .from("telegram_user_scopes")
    .upsert({
      member_id: request.member_id,
      scope_type: request.requested_scope_type,
      scope_code: request.requested_scope_code,
      permission: "RECEIVE_NOTIFICATIONS",
      active: true,
      granted_by: approvedBy,
      granted_at: now,
      updated_at: now,
    }, { onConflict: "member_id,scope_type,scope_code" });
  
  if (scopeError) throw scopeError;
  
  // Record audit event
  await client.from("telegram_access_request_events").insert({
    request_id: requestId,
    event_type: "REQUEST_APPROVED",
    actor: approvedBy,
    metadata: {
      memberId: request.member_id,
      scopeType: request.requested_scope_type,
      scopeCode: request.requested_scope_code,
      notes,
    },
  });
  
  return { ok: true, requestId, message: "Access request approved and scope created" };
}

/**
 * Rejects an access request.
 */
export async function rejectAccessRequest(
  client: SupabaseClient,
  requestId: string,
  rejectedBy: string,
  notes?: string
): Promise<AccessRequestResult> {
  const now = new Date().toISOString();
  
  const { data: request, error: fetchError } = await client
    .from("telegram_access_requests")
    .select("id, member_id, requested_scope_type, requested_scope_code")
    .eq("id", requestId)
    .eq("status", "PENDING")
    .maybeSingle();
  
  if (fetchError) throw fetchError;
  if (!request) return { ok: false, message: "Request not found or already processed" };
  
  const { error: updateError } = await client
    .from("telegram_access_requests")
    .update({
      status: "REJECTED",
      reviewed_by: rejectedBy,
      reviewed_at: now,
      review_notes: notes || null,
      updated_at: now,
    })
    .eq("id", requestId);
  
  if (updateError) throw updateError;
  
  await client.from("telegram_access_request_events").insert({
    request_id: requestId,
    event_type: "REQUEST_REJECTED",
    actor: rejectedBy,
    metadata: {
      memberId: request.member_id,
      scopeType: request.requested_scope_type,
      scopeCode: request.requested_scope_code,
      notes,
    },
  });
  
  return { ok: true, requestId, message: "Access request rejected" };
}
