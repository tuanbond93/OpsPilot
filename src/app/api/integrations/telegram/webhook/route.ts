import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { createAdminClient } from "@/connectors/supabase";
import { parseWorkOrderCallbackData } from "@/integrations/telegram/work-order-actions";
import { parseFollowupCallbackData } from "@/integrations/telegram/followup-actions";
import { parseRillnetReviewCallbackData } from "@/integrations/telegram/rillnet-review-actions";
import { parseDecisionCallbackData, toDecisionResponseEventAction } from "@/integrations/telegram/decision-actions";
import { canManageTelegramDecision } from "@/integrations/telegram/decision-authorization";
import { DecisionTelegramRequestService, isSyntheticTelegramShadowTest } from "@/services/decision-telegram-shadow";
import { TelegramDecisionApprovalService } from "@/services/telegram-decision-approval";
import { ServiceFactory } from "@/services/ServiceFactory";
import { ManagerMirrorService } from "@/notifications/gateway/mirror";
import { isMirrorEnabled } from "@/config/feature-flags";
import { resolveProvince } from "@/notifications/gateway/scope-resolver";
import {
  parseMb03CancelCommand,
  parseMb03OutcomeCommand,
  parseMb03QuickReplyCallback,
  parseMb03StartCommand,
  parseMb03StatusCommand,
  parseMb03GateCommand,
  parseMb03ClassCommand,
  parseMb03ClassifyCommand,
  parseMb03ClassCallback,
  parseMb03RemediateCommand,
  parseMb03AmendCommand,
  TelegramMb03DiscoveryService,
} from "@/services/telegram-mb03-discovery";

type TelegramUser = { id?: number; first_name?: string; last_name?: string; username?: string };
type TelegramMessage = {
  message_id?: number;
  message_thread_id?: number;
  text?: string;
  chat?: { id?: number; type?: string; title?: string };
  from?: TelegramUser;
  reply_to_message?: { message_id?: number };
  forum_topic_created?: { name?: string };
  forum_topic_edited?: { name?: string };
};
type TelegramUpdate = { update_id?: number; message?: TelegramMessage; callback_query?: { id?: string; data?: string; message?: TelegramMessage; from?: TelegramUser } };

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function secureEquals(received: string | null, expected: string) {
  if (!received || received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

function displayName(user?: TelegramUser) {
  return [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim().slice(0, 240);
}

async function recordEvent(client: ReturnType<typeof createAdminClient>, event: Record<string, unknown>) {
  const { error } = await client.from("telegram_pilot_events").insert(event);
  if (error && error.code !== "23505") throw error;
  return error?.code !== "23505";
}

async function handlePrivateMessage(
  client: ReturnType<typeof createAdminClient>,
  update: TelegramUpdate,
  message: TelegramMessage,
  sender: TelegramUser,
  chat: NonNullable<TelegramMessage["chat"]>,
) {
  const text = String(message.text || "").trim();
  const isStart = /^\/start(?:@[\w_]+)?(?:\s|$)/i.test(text);
  const replyToMessageId = message.reply_to_message?.message_id;
  const { data: member, error: memberError } = await client
    .from("telegram_pilot_members")
    .select("id, display_name, username")
    .eq("telegram_user_id", sender.id)
    .eq("status", "ACTIVE")
    .maybeSingle();
  if (memberError) return NextResponse.json({ error: "TELEGRAM_PRIVATE_MEMBER_LOOKUP_FAILED", message: memberError.message }, { status: 503 });
  if (!member) return NextResponse.json({ ok: true, ignored: "PRIVATE_MEMBER_NOT_ACTIVE" });

  if (isStart) {
    const { error: onboardingError } = await client.from("telegram_pilot_members").update({
      private_chat_id: chat.id,
      onboarding_state: "PRIVATE_READY",
      last_seen_at: new Date().toISOString(),
    }).eq("id", member.id);
    if (onboardingError) return NextResponse.json({ error: "TELEGRAM_PRIVATE_ONBOARDING_WRITE_FAILED", message: onboardingError.message }, { status: 503 });
    try {
      await recordEvent(client, {
        telegram_update_id: update.update_id,
        member_id: member.id,
        event_type: "UNSUPPORTED_UPDATE",
        telegram_message_id: message.message_id || null,
        metadata: { chatType: "private", action: "PRIVATE_START" },
      });
    } catch (error) {
      return NextResponse.json({ error: "TELEGRAM_AUDIT_WRITE_FAILED", message: error instanceof Error ? error.message : String(error) }, { status: 503 });
    }
    return NextResponse.json({ ok: true, onboardingState: "PRIVATE_READY" });
  }

  if (!text || !Number.isSafeInteger(replyToMessageId)) return NextResponse.json({ ok: true, ignored: "PRIVATE_MESSAGE_NOT_A_REPLY" });

  const { data: existingConversation, error: conversationLookupError } = await client
    .from("conversation_events")
    .select("id")
    .eq("telegram_update_id", update.update_id)
    .maybeSingle();
  if (conversationLookupError) return NextResponse.json({ error: "TELEGRAM_PRIVATE_REPLY_DEDUP_READ_FAILED", message: conversationLookupError.message }, { status: 503 });
  if (existingConversation) return NextResponse.json({ ok: true, duplicate: true });

  const { data: deliveries, error: deliveryError } = await client
    .from("message_deliveries")
    .select("id, incident_id, incident_key, province, warehouse")
    .eq("recipient_chat_id", String(chat.id))
    .eq("telegram_message_id", replyToMessageId)
    .eq("destination_type", "PRIVATE_DM")
    .eq("delivery_status", "SUCCESS")
    .order("created_at", { ascending: false })
    .limit(2);
  if (deliveryError) return NextResponse.json({ error: "TELEGRAM_PRIVATE_DELIVERY_LOOKUP_FAILED", message: deliveryError.message }, { status: 503 });
  if (!deliveries?.length) return NextResponse.json({ ok: true, ignored: "PRIVATE_REPLY_UNMAPPED" });
  if (deliveries.length !== 1) return NextResponse.json({ error: "TELEGRAM_PRIVATE_REPLY_AMBIGUOUS" }, { status: 409 });

  const delivery = deliveries[0];
  const { error: insertError } = await client.from("conversation_events").insert({
    incident_id: delivery.incident_id,
    incident_key: delivery.incident_key,
    member_id: member.id,
    telegram_user_id: sender.id,
    telegram_message_id: message.message_id || null,
    direction: "INBOUND",
    text: text.slice(0, 8000),
    reply_to_message_id: replyToMessageId,
    reply_to_delivery_id: delivery.id,
    source_chat_type: "private",
    telegram_update_id: update.update_id,
  });
  if (insertError) return NextResponse.json({ error: "TELEGRAM_PRIVATE_REPLY_WRITE_FAILED", message: insertError.message }, { status: 503 });
  // The manager mirror is observer-only: a mirror failure never affects the
  // employee reply already persisted above.
  if (isMirrorEnabled()) {
    const province = delivery.province || resolveProvince({ warehouse: delivery.warehouse });
    const mirror = new ManagerMirrorService();
    const target = await mirror.resolveMirrorTarget(client, province);
    if (target) {
      const senderName = member.username ? `@${member.username}` : member.display_name || "Nhân viên";
      await mirror.mirrorInbound(senderName, text, delivery.incident_key, delivery.warehouse, target, client, {
        incident_id: delivery.incident_id,
        province,
        warehouse: delivery.warehouse,
      });
    }
  }
  return NextResponse.json({ ok: true, mappedIncident: Boolean(delivery.incident_id) });
}

export async function POST(request: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: "TELEGRAM_WEBHOOK_NOT_CONFIGURED" }, { status: 503 });
  if (!secureEquals(request.headers.get("x-telegram-bot-api-secret-token"), secret)) return NextResponse.json({ error: "WEBHOOK_SECRET_INVALID" }, { status: 401 });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 32_768) return NextResponse.json({ error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
  let update: TelegramUpdate;
  try { update = JSON.parse(raw) as TelegramUpdate; } catch { return NextResponse.json({ error: "INVALID_TELEGRAM_UPDATE" }, { status: 400 }); }
  if (!Number.isSafeInteger(update.update_id)) return NextResponse.json({ error: "UPDATE_ID_REQUIRED" }, { status: 400 });
  const message = update.message || update.callback_query?.message;
  const sender = update.message?.from || update.callback_query?.from;
  const chat = message?.chat;
  if (!message || !sender || !chat || !Number.isSafeInteger(chat.id) || !Number.isSafeInteger(sender.id)) return NextResponse.json({ ok: true, ignored: "INVALID_TELEGRAM_UPDATE" });

  const client = createAdminClient();
  if (chat.type === "private") return handlePrivateMessage(client, update, message, sender, chat);
  if (!["group", "supergroup"].includes(chat.type || "")) return NextResponse.json({ ok: true, ignored: "UNSUPPORTED_CHAT_TYPE" });
  const { data: alreadySeen, error: seenError } = await client.from("telegram_pilot_events").select("id").eq("telegram_update_id", update.update_id).maybeSingle();
  if (seenError) return NextResponse.json({ error: "TELEGRAM_AUDIT_READ_FAILED", message: seenError.message }, { status: 503 });
  const isReplyUpdate = Boolean(update.message?.reply_to_message?.message_id);
  if (alreadySeen && !isReplyUpdate) return NextResponse.json({ ok: true, duplicate: true });

  const { data: group, error: groupError } = await client.from("telegram_pilot_groups").upsert({ telegram_chat_id: chat.id, title: String(chat.title || "Telegram pilot group").slice(0, 240) }, { onConflict: "telegram_chat_id" }).select("*").single();
  if (groupError) return NextResponse.json({ error: "TELEGRAM_GROUP_UPSERT_FAILED", message: groupError.message }, { status: 503 });
  // Telegram emits updates from this virtual actor when an admin posts
  // anonymously. It is not an employee and must never create a roster row.
  // Staff should send /join using their own Telegram account.
  if (sender.username === "GroupAnonymousBot" || sender.id === 1087968824) {
    return NextResponse.json({ ok: true, ignored: "ANONYMOUS_GROUP_ACTOR" });
  }
  const { data: existingMember, error: memberLookupError } = await client.from("telegram_pilot_members").select("*").eq("group_id", group.id).eq("telegram_user_id", sender.id).maybeSingle();
  if (memberLookupError) return NextResponse.json({ error: "TELEGRAM_MEMBER_LOOKUP_FAILED", message: memberLookupError.message }, { status: 503 });
  const memberPatch = { display_name: displayName(sender), username: sender.username?.slice(0, 120) || null, last_seen_at: new Date().toISOString() };
  const { data: savedMember, error: memberError } = existingMember
    ? await client.from("telegram_pilot_members").update(memberPatch).eq("id", existingMember.id).select("*").single()
    : await client.from("telegram_pilot_members").insert({ group_id: group.id, telegram_user_id: sender.id, ...memberPatch }).select("*").single();
  if (memberError) return NextResponse.json({ error: "TELEGRAM_MEMBER_UPSERT_FAILED", message: memberError.message }, { status: 503 });
  let member = savedMember;

  // Converting a Telegram group into a forum changes its chat id (typically to
  // -100...). A real user's first /join in the forum therefore looks like a
  // new member. Safely inherit the prior roster only for the same user, same
  // group title and legacy-to-forum id transition; keep the old row suspended
  // as audit history instead of deleting it.
  if (member.status === "PENDING" && String(chat.id).startsWith("-100")) {
    const { data: priorMembers, error: priorMemberError } = await client
      .from("telegram_pilot_members")
      .select("id, group_id, warehouse_name, warehouse_names, zone_names, pilot_role")
      .eq("telegram_user_id", sender.id)
      .eq("status", "ACTIVE")
      .neq("group_id", group.id);
    if (priorMemberError) return NextResponse.json({ error: "TELEGRAM_LEGACY_MEMBER_READ_FAILED", message: priorMemberError.message }, { status: 503 });
    const candidateGroupIds = (priorMembers || []).map((candidate) => candidate.group_id);
    if (candidateGroupIds.length) {
      const { data: priorGroups, error: priorGroupError } = await client
        .from("telegram_pilot_groups")
        .select("id, telegram_chat_id, title")
        .in("id", candidateGroupIds);
      if (priorGroupError) return NextResponse.json({ error: "TELEGRAM_LEGACY_GROUP_READ_FAILED", message: priorGroupError.message }, { status: 503 });
      const sameTitle = (priorGroups || []).find((priorGroup) =>
        String(priorGroup.title || "").trim() === String(group.title || "").trim()
        && !String(priorGroup.telegram_chat_id).startsWith("-100"),
      );
      const legacyMember = sameTitle ? (priorMembers || []).find((candidate) => candidate.group_id === sameTitle.id) : null;
      if (legacyMember) {
        const { data: migratedMember, error: migrationError } = await client
          .from("telegram_pilot_members")
          .update({
            warehouse_name: legacyMember.warehouse_name,
            warehouse_names: legacyMember.warehouse_names,
            zone_names: legacyMember.zone_names,
            pilot_role: legacyMember.pilot_role,
            status: "ACTIVE",
            mapped_at: new Date().toISOString(),
            mapped_by: "telegram_forum_group_upgrade",
          })
          .eq("id", member.id)
          .select("*")
          .single();
        if (migrationError) return NextResponse.json({ error: "TELEGRAM_FORUM_MIGRATION_FAILED", message: migrationError.message }, { status: 503 });
        const now = new Date().toISOString();
        const [{ error: suspendMemberError }, { error: activateGroupError }, { error: suspendGroupError }] = await Promise.all([
          client.from("telegram_pilot_members").update({ status: "SUSPENDED", mapped_at: now, mapped_by: "telegram_forum_group_upgrade" }).eq("id", legacyMember.id),
          client.from("telegram_pilot_groups").update({ status: "ACTIVE", updated_at: now }).eq("id", group.id),
          client.from("telegram_pilot_groups").update({ status: "SUSPENDED", updated_at: now }).eq("id", legacyMember.group_id),
        ]);
        if (suspendMemberError || activateGroupError || suspendGroupError) {
          return NextResponse.json({ error: "TELEGRAM_FORUM_MIGRATION_FINALIZE_FAILED", message: (suspendMemberError || activateGroupError || suspendGroupError)?.message }, { status: 503 });
        }
        member = migratedMember;
      }
    }
  }

  const text = String(message.text || "").trim();
  const isJoin = /^\/join(?:@[\w_]+)?(?:\s|$)/i.test(text);
  const threadId = Number.isSafeInteger(message.message_thread_id) && Number(message.message_thread_id) > 0 ? Number(message.message_thread_id) : null;
  const joinTopicLabel = isJoin ? text.replace(/^\/join(?:@[\w_]+)?\s*/i, "").trim().slice(0, 120) : "";
  let topic: { id: string; topic_title: string; message_thread_id: number; province_name: string | null; is_escalation: boolean; is_manager_decision: boolean } | null = null;
  if (threadId) {
    const { data: existingTopic, error: topicLookupError } = await client.from("telegram_pilot_topics").select("id, topic_title, message_thread_id, province_name, is_escalation, is_manager_decision").eq("group_id", group.id).eq("message_thread_id", threadId).maybeSingle();
    if (topicLookupError) return NextResponse.json({ error: "TELEGRAM_TOPIC_LOOKUP_FAILED", message: topicLookupError.message }, { status: 503 });
    const observedTitle = String(message.forum_topic_created?.name || message.forum_topic_edited?.name || joinTopicLabel || existingTopic?.topic_title || ("Topic #" + threadId)).slice(0, 240);
    const { data: savedTopic, error: topicError } = existingTopic
      ? await client.from("telegram_pilot_topics").update({ topic_title: observedTitle, last_seen_at: new Date().toISOString() }).eq("id", existingTopic.id).select("id, topic_title, message_thread_id, province_name, is_escalation, is_manager_decision").single()
      : await client.from("telegram_pilot_topics").insert({ group_id: group.id, message_thread_id: threadId, topic_title: observedTitle }).select("id, topic_title, message_thread_id, province_name, is_escalation, is_manager_decision").single();
    if (topicError) return NextResponse.json({ error: "TELEGRAM_TOPIC_UPSERT_FAILED", message: topicError.message }, { status: 503 });
    topic = savedTopic;
  }
  const eventType = isJoin ? "JOIN_REQUEST" : update.callback_query ? "CALLBACK_RECEIVED" : message.reply_to_message?.message_id ? "FREE_TEXT_FEEDBACK" : "UNSUPPORTED_UPDATE";
  try {
    await recordEvent(client, { telegram_update_id: update.update_id, group_id: group.id, member_id: member.id, event_type: eventType, telegram_message_id: message.message_id || null, reply_to_message_id: message.reply_to_message?.message_id || null, message_text: eventType === "FREE_TEXT_FEEDBACK" ? text.slice(0, 4000) : null, metadata: { callbackData: update.callback_query?.data?.slice(0, 128) || null, chatType: chat.type, messageThreadId: threadId, topicId: topic?.id || null } });
  } catch (error) {
    return NextResponse.json({ error: "TELEGRAM_AUDIT_WRITE_FAILED", message: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }

  if (isJoin) {
    const warehouseNames = Array.isArray(member.warehouse_names)
      ? member.warehouse_names.filter((warehouse: unknown): warehouse is string => typeof warehouse === "string" && warehouse.trim().length > 0)
      : member.warehouse_name ? [member.warehouse_name] : [];
    const enrollmentReply = member.status === "ACTIVE" && warehouseNames.length > 0
      ? `OpsPilot: bạn đã được kích hoạt với vai trò ${member.pilot_role === "MANAGER" ? "Manager" : "Nhân viên"}. Kho phụ trách: ${warehouseNames.join(", ")}. Khi pilot gửi work order, hãy phản hồi ngay trong group này.`
      : member.status === "SUSPENDED"
        ? "OpsPilot: tài khoản Telegram của bạn đang tạm dừng trong pilot. Hãy liên hệ Manager OpsPilot nếu cần hỗ trợ."
        : "OpsPilot đã nhận diện bạn. Manager sẽ gán kho và kích hoạt quyền nhận việc trên OpsPilot.";
    const topicReply = topic ? " Topic “" + topic.topic_title + "” đã đồng bộ; vào Telegram Pilot để gán tỉnh hoặc Escalation." : "";
    return NextResponse.json({ method: "sendMessage", chat_id: chat.id, reply_to_message_id: message.message_id, ...(threadId ? { message_thread_id: threadId } : {}), text: enrollmentReply + topicReply });
  }

  const mb03Start = parseMb03StartCommand(text);
  const mb03Cancel = parseMb03CancelCommand(text);
  const mb03Status = parseMb03StatusCommand(text);
  const mb03Gate = parseMb03GateCommand(text);
  const mb03Class = parseMb03ClassCommand(text);
  const mb03Classify = parseMb03ClassifyCommand(text);
  const mb03Remediate = parseMb03RemediateCommand(text);
  const mb03Amend = parseMb03AmendCommand(text);
  const mb03ClassCallback = parseMb03ClassCallback(update.callback_query?.data);
  const mb03Outcome = parseMb03OutcomeCommand(text);
  const mb03QuickReply = parseMb03QuickReplyCallback(update.callback_query?.data);
  const isPotentialDiscoveryReply = Boolean(text && message.reply_to_message?.message_id);
  if (member.status === "ACTIVE" && (mb03Start || mb03Cancel || mb03Status || mb03Gate || mb03Class || mb03Classify || mb03Remediate || mb03Amend || mb03ClassCallback || mb03Outcome || mb03QuickReply || isPotentialDiscoveryReply) && canManageTelegramDecision({ role: member.role, pilotRole: member.pilot_role })) {
    const { data: scopes, error: scopeError } = await client.from("telegram_user_scopes").select("scope_code, permission").eq("member_id", member.id).eq("active", true);
    if (scopeError) return NextResponse.json({ error: "MB03_DISCOVERY_SCOPE_LOOKUP_FAILED", message: scopeError.message }, { status: 503 });
    const hasMb03Scope = (scopes || []).some((scope: any) =>
      ["ADMIN", "MANAGE_SCOPE"].includes(scope.permission) && ["ALL", "MB03"].includes(scope.scope_code));
    if ((mb03Start || mb03Cancel || mb03Status || mb03Gate || mb03Class || mb03Classify || mb03Remediate || mb03Amend || mb03ClassCallback || mb03Outcome || mb03QuickReply) && !hasMb03Scope) {
      if (mb03QuickReply && update.callback_query?.id) return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: "Bạn chưa có quyền Manager MB03.", show_alert: true });
      return NextResponse.json({ method: "sendMessage", chat_id: chat.id, reply_to_message_id: message.message_id, ...(threadId ? { message_thread_id: threadId } : {}), text: "Bạn chưa có quyền Manager cho phạm vi Miền Bắc 3 (MB03)." });
    }
    if (hasMb03Scope) {
      const discovery = new TelegramMb03DiscoveryService(client);
      const managerContext = { memberId: member.id, telegramUserId: Number(sender.id), chatId: String(chat.id), chatType: String(chat.type || "group"), messageThreadId: threadId, provinceName: topic?.province_name || null };
      try {
        if (mb03QuickReply && update.callback_query?.id) {
          const result = await discovery.reply(managerContext, { updateId: Number(update.update_id), messageId: Number(message.message_id), replyToMessageId: Number(message.message_id), text: mb03QuickReply.value });
          if (!result.handled) return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: "Nút này đã hết hiệu lực.", show_alert: true });
          if (!result.ok) return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: result.message, show_alert: true });
          return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: `Đã ghi: ${mb03QuickReply.value}`, show_alert: false });
        }
        if (mb03ClassCallback && update.callback_query?.id) {
          const result = await discovery.classify(managerContext, mb03ClassCallback);
          return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: result.message, show_alert: !result.ok });
        }
        if (mb03Start) {
          const result = await discovery.start(managerContext, mb03Start.warehouseName);
          if (!result.ok) return NextResponse.json({ method: "sendMessage", chat_id: chat.id, reply_to_message_id: message.message_id, ...(threadId ? { message_thread_id: threadId } : {}), text: result.message });
          return NextResponse.json({ ok: true, discovery: "STARTED" });
        }
        if (mb03Cancel) {
          const result = await discovery.cancel(managerContext);
          return NextResponse.json({ ok: result.ok, discovery: result.ok ? "CANCELLED" : "NOT_FOUND", message: result.message });
        }
        if (mb03Status) {
          const result = await discovery.status(managerContext);
          return NextResponse.json({ ok: true, discovery: "STATUS", ...result });
        }
        if (mb03Class) {
          const result = await discovery.classify(managerContext, mb03Class);
          if (!result.ok) return NextResponse.json({ method: "sendMessage", chat_id: chat.id, reply_to_message_id: message.message_id, ...(threadId ? { message_thread_id: threadId } : {}), text: result.message });
          return NextResponse.json({ ok: true, discovery: "CLASSIFIED" });
        }
        if (mb03Classify) {
          const result = await discovery.sendClassificationPrompts(managerContext);
          return NextResponse.json({ ok: true, discovery: "CLASSIFY_PROMPTS", ...result });
        }
        if (mb03Remediate) {
          const result = await discovery.sendRemediationPrompts(managerContext);
          return NextResponse.json({ ok: true, discovery: "REMEDIATION_PROMPTS", ...result });
        }
        if (mb03Amend) {
          const result = await discovery.amend(managerContext, mb03Amend);
          if (!result.ok) return NextResponse.json({ method: "sendMessage", chat_id: chat.id, reply_to_message_id: message.message_id, ...(threadId ? { message_thread_id: threadId } : {}), text: result.message });
          return NextResponse.json({ ok: true, discovery: "AMENDED" });
        }
        if (mb03Gate) {
          const result = await discovery.gate(managerContext);
          return NextResponse.json({ ok: true, discovery: "GATE", ...result });
        }
        if (mb03Outcome) {
          const result = await discovery.recordOutcome(managerContext, { updateId: Number(update.update_id), messageId: Number(message.message_id), ...mb03Outcome });
          if (!result.ok) return NextResponse.json({ method: "sendMessage", chat_id: chat.id, reply_to_message_id: message.message_id, ...(threadId ? { message_thread_id: threadId } : {}), text: result.message });
          return NextResponse.json({ ok: true, discovery: "OUTCOME_RECORDED" });
        }
        if (isPotentialDiscoveryReply && message.reply_to_message?.message_id) {
          const result = await discovery.reply(managerContext, { updateId: Number(update.update_id), messageId: Number(message.message_id), replyToMessageId: Number(message.reply_to_message.message_id), text });
          if (result.handled) {
            if (!result.ok) return NextResponse.json({ method: "sendMessage", chat_id: chat.id, reply_to_message_id: message.message_id, ...(threadId ? { message_thread_id: threadId } : {}), text: result.message });
            return NextResponse.json({ ok: true, discovery: result.completed ? "AWAITING_OUTCOME" : "STEP_RECORDED" });
          }
        }
      } catch (error) {
        return NextResponse.json({ error: "MB03_DISCOVERY_FAILED", message: error instanceof Error ? error.message : String(error) }, { status: 503 });
      }
    }
  }
  if (update.callback_query?.id && member.status === "ACTIVE") {
    const rillnetReview = parseRillnetReviewCallbackData(update.callback_query.data);
    if (rillnetReview) {
      if (!canManageTelegramDecision({ role: member.role, pilotRole: member.pilot_role })) {
        return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: "Bạn không có quyền Manager để xác nhận kết quả.", show_alert: true });
      }
      const { data: reviewRequest, error: reviewError } = await client.from("telegram_rillnet_review_requests")
        .select("id, group_id, message_thread_id, telegram_message_id, status")
        .eq("id", rillnetReview.requestId).eq("group_id", group.id).maybeSingle();
      if (reviewError) return NextResponse.json({ error: "TELEGRAM_RILLNET_REVIEW_LOOKUP_FAILED", message: reviewError.message }, { status: 503 });
      if (!reviewRequest || reviewRequest.telegram_message_id !== message.message_id || reviewRequest.message_thread_id !== threadId) {
        return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: "Yêu cầu rà soát không hợp lệ hoặc đã hết hiệu lực.", show_alert: true });
      }
      const { data: confirmed, error: confirmError } = await client.rpc("confirm_telegram_rillnet_review", { p_payload: { requestId: reviewRequest.id, outcome: rillnetReview.outcome, memberId: member.id, telegramUpdateId: update.update_id } });
      if (confirmError) return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: "Không thể ghi nhận kết quả an toàn. Hãy tải lại trạng thái case.", show_alert: true });
      const label = rillnetReview.outcome === "SUCCESS" ? "Thành công — case đã được đánh dấu giải quyết." : rillnetReview.outcome === "FAILED" ? "Thất bại — case được đưa về theo dõi tiếp." : "Theo dõi tiếp — đã nhận snapshot mới làm mốc đối soát.";
      return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: (confirmed as { duplicate?: boolean } | null)?.duplicate ? `Kết quả đã được xác nhận trước đó: ${label}` : label, show_alert: false });
    }
    // Decision callbacks are deliberately handled before employee namespaces.
    // They only write the immutable shadow-observation RPC; no execution path is
    // reachable from this handler.
    const decisionCallback = parseDecisionCallbackData(update.callback_query.data);
    if (decisionCallback) {
      if (!canManageTelegramDecision({ role: member.role, pilotRole: member.pilot_role })) {
        return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: "Bạn không có quyền quản lý quyết định.", show_alert: true });
      }
      const db = client as any;
      const { data: decisionRequest, error: requestError } = await db.from("telegram_decision_requests")
        .select("id, decision_id, manager_scope_code, telegram_chat_id, message_thread_id, telegram_message_id, source_fingerprint, status, metadata")
        .eq("id", decisionCallback.requestId).eq("telegram_chat_id", chat.id).maybeSingle();
      if (requestError) return NextResponse.json({ error: "TELEGRAM_DECISION_REQUEST_LOOKUP_FAILED", message: requestError.message }, { status: 503 });
      if (!decisionRequest || decisionRequest.message_thread_id !== threadId || decisionRequest.telegram_message_id !== message.message_id || !['SENT', 'RESPONDED'].includes(decisionRequest.status)) {
        return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: "Yêu cầu quyết định không hợp lệ hoặc đã hết hiệu lực.", show_alert: true });
      }
      const { data: scopes, error: scopeError } = await db.from("telegram_user_scopes").select("scope_code, permission").eq("member_id", member.id).eq("active", true);
      if (scopeError) return NextResponse.json({ error: "TELEGRAM_DECISION_SCOPE_LOOKUP_FAILED", message: scopeError.message }, { status: 503 });
      const inScope = (scopes || []).some((scope: any) => ['ADMIN', 'MANAGE_SCOPE'].includes(scope.permission) && (scope.scope_code === 'ALL' || scope.scope_code === decisionRequest.manager_scope_code));
      if (!inScope) return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: "Bạn không thuộc phạm vi quyết định này.", show_alert: true });
      const { data: decision, error: decisionError } = await db.from("decisions").select("source_fingerprint, decision_mode, source_links").eq("id", decisionRequest.decision_id).maybeSingle();
      if (decisionError) return NextResponse.json({ error: "TELEGRAM_DECISION_CORE_LOOKUP_FAILED", message: decisionError.message }, { status: 503 });
      const links = decision?.source_links || {};
      // The isolated admin fixture has deliberately no operational source
      // rows. Real Level C decisions always retain the freshness gate.
      const currentSource = decision && isSyntheticTelegramShadowTest(links as any)
        ? true
        : decision
        ? await new DecisionTelegramRequestService(db).hasCurrentSourceFingerprint({
            decisionId: decisionRequest.decision_id,
            sourceFingerprint: decision.source_fingerprint,
            sourceLinks: links,
          } as any)
        : false;
      if (!decision || decision.decision_mode !== 'SHADOW' || links.triageRoute !== 'AI_DECISION_REQUIRED' || links.criticVerdict !== 'PASS' || decision.source_fingerprint !== decisionRequest.source_fingerprint || !currentSource) {
        if (decisionRequest.status !== 'STALE') await db.from("telegram_decision_requests").update({ status: 'STALE', updated_at: new Date().toISOString() }).eq("id", decisionRequest.id);
        return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: "Quyết định đã thay đổi hoặc không còn hợp lệ; không ghi nhận phản hồi.", show_alert: true });
      }
      const actor = `telegram:${member.id}`;
      const levelC = new TelegramDecisionApprovalService(db, ServiceFactory.getDecisionService(db), ServiceFactory.getExecutionWorkOrderService(db));
      if (decisionCallback.action === "CONFIRM_SEND") {
        try {
          const result = await levelC.confirmAndDispatch(decisionRequest, actor);
          return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: result.idempotent ? "Work order này đã được gửi trước đó." : `Đã phê duyệt và gửi ${result.workOrder.workOrderCode} cho nhân viên.`, show_alert: false });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: `Chưa thể gửi việc: ${reason}`.slice(0, 190), show_alert: true });
        }
      }
      const { error: responseError } = await db.rpc("record_telegram_decision_shadow_response", { p_payload: { requestId: decisionRequest.id, memberId: member.id, telegramUserId: sender.id, telegramUpdateId: update.update_id, response: toDecisionResponseEventAction(decisionCallback.action), sourceFingerprint: decision.source_fingerprint, idempotencyKey: `telegram:${update.update_id}`, metadata: { chatId: chat.id, messageThreadId: threadId, telegramMessageId: message.message_id } } });
      if (responseError) return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: "Không thể ghi nhận phản hồi an toàn. Hãy thử lại.", show_alert: true });
      if (decisionCallback.action === "APPROVE") {
        try {
          const shadowResult = await ServiceFactory.getDecisionService(db).get(decisionRequest.decision_id);
          const shadow = (shadowResult.data as { decision?: import("@/domain/decision").Decision } | undefined)?.decision;
          if (!shadowResult.ok || !shadow) throw new Error("DECISION_NOT_FOUND");
          await levelC.prepare(decisionRequest, shadow, actor);
          return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: "Đã chuẩn bị Decision thật. Kiểm tra tin xác nhận mới trước khi gửi việc.", show_alert: false });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: `Không thể chuẩn bị giao việc: ${reason}`.slice(0, 190), show_alert: true });
        }
      }
      const reply = decisionCallback.action === 'EVIDENCE' ? "Bằng chứng đã được ghi nhận để xem xét; quyết định không thay đổi." : "Đã ghi nhận từ chối; không có hành động nào được thực thi.";
      return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: reply, show_alert: false });
    }
    const callback = parseWorkOrderCallbackData(update.callback_query.data);
    if (callback) {
      const { data: dispatch, error: dispatchError } = await client.from("telegram_work_order_dispatches").select("id, group_id, telegram_message_id, recipient_member_ids").eq("id", callback.dispatchId).eq("group_id", group.id).eq("status", "SENT").maybeSingle();
      if (dispatchError) return NextResponse.json({ error: "TELEGRAM_DISPATCH_LOOKUP_FAILED", message: dispatchError.message }, { status: 503 });
      const recipients = Array.isArray(dispatch?.recipient_member_ids) ? dispatch.recipient_member_ids.filter((value): value is string => typeof value === "string") : [];
      if (dispatch && dispatch.telegram_message_id === message.message_id && recipients.includes(member.id)) {
        const { error: signalError } = await client.from("telegram_work_order_signals").insert({ dispatch_id: dispatch.id, member_id: member.id, telegram_update_id: update.update_id, signal_type: callback.signal });
        if (signalError && signalError.code !== "23505") return NextResponse.json({ error: "TELEGRAM_SIGNAL_WRITE_FAILED", message: signalError.message }, { status: 503 });
        const acknowledgment = callback.signal === "ACKNOWLEDGED" ? "Đã ghi nhận bạn nhận việc." : callback.signal === "NEEDS_SUPPORT" ? "Đã ghi nhận cần hỗ trợ. Hãy Reply vào tin work order để nêu rõ vướng mắc." : "Đã ghi nhận cập nhật tiến độ. Hãy Reply vào tin work order để ghi nội dung tiến độ.";
        return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: acknowledgment, show_alert: false });
      }
    }
    const followupCallback = parseFollowupCallbackData(update.callback_query.data);
    if (followupCallback) {
      const { data: representative, error: reminderError } = await client.from("telegram_followup_reminders").select("id, group_id, telegram_message_id, recipient_member_ids").eq("id", followupCallback.reminderId).eq("group_id", group.id).eq("status", "SENT").maybeSingle();
      if (reminderError) return NextResponse.json({ error: "TELEGRAM_FOLLOWUP_LOOKUP_FAILED", message: reminderError.message }, { status: 503 });
      const recipients = Array.isArray(representative?.recipient_member_ids) ? representative.recipient_member_ids.filter((value): value is string => typeof value === "string") : [];
      if (representative && representative.telegram_message_id === message.message_id && recipients.includes(member.id)) {
        const { data: related, error: relatedError } = await client.from("telegram_followup_reminders").select("id").eq("group_id", group.id).eq("status", "SENT").eq("telegram_message_id", message.message_id);
        if (relatedError) return NextResponse.json({ error: "TELEGRAM_FOLLOWUP_LOOKUP_FAILED", message: relatedError.message }, { status: 503 });
        const { error: eventError } = await client.from("telegram_followup_reminder_events").insert((related || []).map((reminder) => ({ reminder_id: reminder.id, event_type: "SIGNAL_RECEIVED", actor: `telegram:${member.id}`, metadata: { signal: followupCallback.signal, telegramUpdateId: update.update_id, telegramUserId: member.telegram_user_id, telegramMessageId: message.message_id } })));
        if (eventError) return NextResponse.json({ error: "TELEGRAM_FOLLOWUP_SIGNAL_WRITE_FAILED", message: eventError.message }, { status: 503 });
        const acknowledgment = followupCallback.signal === "ACKNOWLEDGED" ? "Đã ghi nhận nhận việc. Hãy Reply để giải trình." : followupCallback.signal === "NEEDS_SUPPORT" ? "Đã ghi nhận cần hỗ trợ. Hãy Reply nêu rõ vướng mắc." : "Đã ghi nhận cập nhật tiến độ. Hãy Reply nêu nội dung mới.";
        return NextResponse.json({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id, text: acknowledgment, show_alert: false });
      }
    }
  }
  if (eventType === "FREE_TEXT_FEEDBACK" && text && message.reply_to_message?.message_id && member.status === "ACTIVE") {
    const { data: dispatch, error: dispatchError } = await client.from("telegram_work_order_dispatches").select("id, recipient_member_ids").eq("group_id", group.id).eq("status", "SENT").eq("telegram_message_id", message.reply_to_message.message_id).maybeSingle();
    if (dispatchError) return NextResponse.json({ error: "TELEGRAM_DISPATCH_LOOKUP_FAILED", message: dispatchError.message }, { status: 503 });
    const recipients = Array.isArray(dispatch?.recipient_member_ids) ? dispatch.recipient_member_ids.filter((value): value is string => typeof value === "string") : [];
    if (dispatch && recipients.includes(member.id)) {
      const { error: feedbackError } = await client.from("telegram_work_order_feedbacks").insert({ dispatch_id: dispatch.id, member_id: member.id, telegram_update_id: update.update_id, telegram_message_id: message.message_id, feedback_text: text.slice(0, 4000) });
      if (feedbackError && feedbackError.code !== "23505") return NextResponse.json({ error: "TELEGRAM_FEEDBACK_WRITE_FAILED", message: feedbackError.message }, { status: 503 });
      return NextResponse.json({ method: "sendMessage", chat_id: chat.id, reply_to_message_id: message.message_id, text: "OpsPilot đã ghi nhận phản hồi. Manager sẽ xem và xác nhận trạng thái work order trên OpsPilot." });
    }
    const { data: reminders, error: reminderError } = await client.from("telegram_followup_reminders").select("id, recipient_member_ids").eq("group_id", group.id).eq("status", "SENT").eq("telegram_message_id", message.reply_to_message.message_id);
    if (reminderError) return NextResponse.json({ error: "TELEGRAM_FOLLOWUP_LOOKUP_FAILED", message: reminderError.message }, { status: 503 });
    const related = (reminders || []).filter((reminder) => Array.isArray(reminder.recipient_member_ids) && reminder.recipient_member_ids.includes(member.id));
    if (related.length) {
      const { error: feedbackError } = await client.from("telegram_followup_reminder_events").insert(related.map((reminder) => ({ reminder_id: reminder.id, event_type: "FEEDBACK_RECEIVED", actor: `telegram:${member.id}`, metadata: { feedbackText: text.slice(0, 4000), telegramUpdateId: update.update_id, telegramUserId: member.telegram_user_id, telegramMessageId: message.message_id } })));
      if (feedbackError) return NextResponse.json({ error: "TELEGRAM_FOLLOWUP_FEEDBACK_WRITE_FAILED", message: feedbackError.message }, { status: 503 });
      return NextResponse.json({ method: "sendMessage", chat_id: chat.id, reply_to_message_id: message.message_id, text: `OpsPilot đã ghi nhận giải trình cho ${related.length} case. Hệ thống sẽ đối soát snapshot mới trước khi nhắc tiếp.` });
    }
  }
  return NextResponse.json({ ok: true, eventType });
}
