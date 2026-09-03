import { TelegramClient } from "@/integrations/telegram/telegram-client";
import { latestMb03States, type Mb03ConversationEvent } from "@/services/telegram-mb03-readiness";
import type { Mb03DiscoveryState } from "@/services/telegram-mb03-discovery";

type ReminderResult = { scanned: number; sent: number; skipped: number; failed: number; caseIds: string[] };

function messageFor(state: Mb03DiscoveryState) {
  return [
    `⏰ MB03 — cần kết quả cuối cho ${state.caseId}`,
    `Kho: ${state.warehouseName}`,
    `Đã đến hạn ghi outcome. Hãy kiểm tra snapshot mới trước khi trả lời.`,
    `Reply: /mb03outcome ${state.caseId} SUCCESS|FAILURE|INCONCLUSIVE <evidence định lượng>`,
    "Bot chỉ ghi nhận evidence; không tự kết luận hoặc thay đổi vận hành.",
  ].join("\n");
}

/** Sends at most one durable reminder per due MB03 case. */
export async function dispatchDueMb03OutcomeReminders(client: any, now = new Date(), telegram = new TelegramClient()): Promise<ReminderResult> {
  const { data, error } = await client.from("conversation_events")
    .select("member_id,telegram_user_id,source_chat_type,ai_result,created_at")
    .eq("direction", "OUTBOUND")
    .contains("ai_result", { type: "MB03_DISCOVERY" })
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw error;

  const events = (data || []) as Mb03ConversationEvent[];
  const states = latestMb03States(events);
  const due = [...states.values()].filter((state) => state.status === "AWAITING_OUTCOME"
    && !state.reminderSentAt
    && Number.isFinite(Date.parse(String(state.outcomeDueAt || "")))
    && Date.parse(String(state.outcomeDueAt)) <= now.getTime());
  const result: ReminderResult = { scanned: states.size, sent: 0, skipped: states.size - due.length, failed: 0, caseIds: [] };

  for (const state of due) {
    try {
      const sent = await telegram.sendToChat(state.chatId, messageFor(state), { messageThreadId: state.messageThreadId });
      const latestEvent = events.find((event) => (event.ai_result as { caseId?: string } | null)?.caseId === state.caseId);
      const reminderState = { ...state, reminderSentAt: now.toISOString(), updatedAt: now.toISOString() };
      const { error: persistError } = await client.from("conversation_events").insert({
        member_id: latestEvent?.member_id || null,
        telegram_user_id: latestEvent?.telegram_user_id || null,
        telegram_message_id: Number(sent.messageId),
        direction: "OUTBOUND",
        text: messageFor(state),
        source_chat_type: latestEvent?.source_chat_type || "supergroup",
        ai_result: reminderState,
      });
      if (persistError) throw persistError;
      result.sent += 1;
      result.caseIds.push(state.caseId);
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
