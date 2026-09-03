import { describe, expect, it, vi } from "vitest";
import { dispatchDueMb03OutcomeReminders } from "../services/telegram-mb03-outcome-reminders";

function event(caseId: string, dueAt: string, status = "AWAITING_OUTCOME") {
  return {
    member_id: "member-1", telegram_user_id: 1, source_chat_type: "supergroup", created_at: "2026-08-31T08:00:00.000Z",
    ai_result: { type: "MB03_DISCOVERY", caseId, status, warehouseName: "Kho MB03", chatId: "-100", messageThreadId: 10, updatedAt: "2026-08-31T08:00:00.000Z", outcomeDueAt: dueAt },
  };
}

describe("MB03 outcome reminders", () => {
  it("sends and persists exactly one reminder for each due case", async () => {
    const inserts: unknown[] = [];
    const query: any = { select: () => query, eq: () => query, contains: () => query, order: () => query, limit: async () => ({ data: [event("MB03-20260831-0800", "2026-08-31T09:00:00.000Z"), event("MB03-20260831-0801", "2026-08-31T13:00:00.000Z")], error: null }), insert: async (value: unknown) => { inserts.push(value); return { error: null }; } };
    const client = { from: vi.fn(() => query) };
    const sendToChat = vi.fn().mockResolvedValue({ messageId: "99", response: {} });

    const result = await dispatchDueMb03OutcomeReminders(client, new Date("2026-08-31T12:00:00.000Z"), { sendToChat } as any);

    expect(result).toMatchObject({ scanned: 2, sent: 1, skipped: 1, failed: 0, caseIds: ["MB03-20260831-0800"] });
    expect(sendToChat).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);
  });
});
