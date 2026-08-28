import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { createAdminClient } from "@/connectors/supabase";
import { parseWorkOrderCallbackData } from "@/integrations/telegram/work-order-actions";
import { parseFollowupCallbackData } from "@/integrations/telegram/followup-actions";

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
  if (!message || !sender || !chat || !Number.isSafeInteger(chat.id) || !Number.isSafeInteger(sender.id) || !["group", "supergroup"].includes(chat.type || "")) {
    return NextResponse.json({ ok: true, ignored: "NOT_A_GROUP_MEMBER_UPDATE" });
  }

  const client = createAdminClient();
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
  let topic: { id: string; topic_title: string; message_thread_id: number } | null = null;
  if (threadId) {
    const { data: existingTopic, error: topicLookupError } = await client.from("telegram_pilot_topics").select("id, topic_title, message_thread_id").eq("group_id", group.id).eq("message_thread_id", threadId).maybeSingle();
    if (topicLookupError) return NextResponse.json({ error: "TELEGRAM_TOPIC_LOOKUP_FAILED", message: topicLookupError.message }, { status: 503 });
    const observedTitle = String(message.forum_topic_created?.name || message.forum_topic_edited?.name || joinTopicLabel || existingTopic?.topic_title || ("Topic #" + threadId)).slice(0, 240);
    const { data: savedTopic, error: topicError } = existingTopic
      ? await client.from("telegram_pilot_topics").update({ topic_title: observedTitle, last_seen_at: new Date().toISOString() }).eq("id", existingTopic.id).select("id, topic_title, message_thread_id").single()
      : await client.from("telegram_pilot_topics").insert({ group_id: group.id, message_thread_id: threadId, topic_title: observedTitle }).select("id, topic_title, message_thread_id").single();
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
  if (update.callback_query?.id && member.status === "ACTIVE") {
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
