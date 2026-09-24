import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendIncidentSyncStatus } from "@/services/telegram-incident-status";

const telegram = vi.hoisted(() => ({ sendToChat: vi.fn() }));
vi.mock("@/integrations/telegram", () => ({
  TelegramClient: class TelegramClientMock {
    sendToChat(...args: unknown[]) { return telegram.sendToChat(...args); }
  },
}));

type Followup = {
  id: string;
  incident_id: string;
  current_state: string;
  latest_affected_order_count: number;
  resolved_at: string | null;
};
type StatusRow = {
  followup_case_id: string;
  sync_run_id: string;
  update_kind: string;
  status: string;
  failure_reason?: string | null;
};

function makeClient(input: {
  followups: Followup[];
  syncRunId: string;
  priorSentResolved?: string[];
  sentUpdateError?: { code: string; message: string } | null;
  resolvedLookupError?: { code: string; message: string } | null;
} ) {
  const rows: StatusRow[] = [];
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ values: Record<string, unknown>; ids: string[] }> = [];
  let resolvedLookupCount = 0;
  const incidentRows = input.followups.map((followup) => ({
    id: followup.incident_id,
    warehouse_id: "20121005",
    warehouse_name: "(LCH) Nậm Mạ",
    reason_name: `reason-${followup.id}`,
  }));
  const histories = input.followups.map((followup) => ({
    incident_id: followup.incident_id,
    sync_run_id: input.syncRunId,
    affected_order_count: followup.latest_affected_order_count,
    recorded_at: "2026-09-24T07:00:00.000Z",
  }));

  const client = {
    from(table: string) {
      if (table === "followup_cases") return {
        select: () => ({ limit: async () => ({ data: input.followups, error: null }) }),
      };
      if (table === "telegram_pilot_topics") return {
        select: () => ({
          eq: () => ({
            eq: async () => ({ data: [{
              group_id: "group-1",
              message_thread_id: 7,
              province_name: "Lai Châu",
              is_escalation: false,
              is_manager_decision: false,
              telegram_pilot_groups: { telegram_chat_id: "1234", status: "ACTIVE" },
            }], error: null }),
          }),
        }),
      };
      if (table === "incidents") return {
        select: () => ({ in: async (_column: string, ids: string[]) => ({
          data: incidentRows.filter((row) => ids.includes(row.id)),
          error: null,
        }) }),
      };
      if (table === "telegram_incident_status_updates") return {
        select: () => ({
          eq: (firstColumn: string, firstValue: string) => ({
            eq: (secondColumn: string, secondValue: string) => ({
              in: async (idColumn: string, ids: string[]) => {
                resolvedLookupCount++;
                if (input.resolvedLookupError) return { data: null, error: input.resolvedLookupError };
                expect([firstColumn, secondColumn, idColumn]).toEqual(["update_kind", "status", "followup_case_id"]);
                expect([firstValue, secondValue]).toEqual(["RESOLVED", "SENT"]);
                return { data: (input.priorSentResolved || []).filter((id) => ids.includes(id)).map((id) => ({ followup_case_id: id })), error: null };
              },
            }),
          }),
        }),
        insert: async (values: Record<string, unknown>) => {
          inserts.push(values);
          const duplicate = rows.some((row) => row.sync_run_id === values.sync_run_id && row.followup_case_id === values.followup_case_id);
          if (duplicate) return { error: { code: "23505", message: "duplicate run/case" } };
          rows.push({ ...(values as StatusRow), status: "PENDING" });
          return { error: null };
        },
        update: (values: Record<string, unknown>) => ({
          eq: (_column: string, syncRunId: string) => ({
            in: async (_idColumn: string, ids: string[]) => {
              updates.push({ values, ids });
              if (values.status === "SENT" && input.sentUpdateError) return { error: input.sentUpdateError };
              for (const row of rows) {
                if (row.sync_run_id === syncRunId && ids.includes(row.followup_case_id)) Object.assign(row, values);
              }
              return { error: null };
            },
          }),
        }),
      };
      throw new Error(`Unexpected table: ${table}`);
    },
    async rpc() { return { data: histories, error: null }; },
  };
  return { client, rows, inserts, updates, get resolvedLookupCount() { return resolvedLookupCount; } };
}

const resolved = (id: string): Followup => ({
  id,
  incident_id: `incident-${id}`,
  current_state: "RESOLVED",
  latest_affected_order_count: 0,
  resolved_at: "2026-09-24T06:59:00.000Z",
});
const active = (id: string): Followup => ({
  id,
  incident_id: `incident-${id}`,
  current_state: "OPEN",
  latest_affected_order_count: 5,
  resolved_at: null,
});

describe("Telegram incident-status idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    telegram.sendToChat.mockResolvedValue({ messageId: 99 });
  });

  it("excludes a resolved case with a prior SENT notice before insert or send", async () => {
    const state = makeClient({ followups: [resolved("already-sent")], syncRunId: "run-1", priorSentResolved: ["already-sent"] });

    const result = await sendIncidentSyncStatus(state.client as never, "run-1", "2026-09-24T07:00:00.000Z");

    expect(state.resolvedLookupCount).toBe(1);
    expect(state.inserts).toHaveLength(0);
    expect(telegram.sendToChat).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("sends and persists a resolved case with no prior SENT notice", async () => {
    const state = makeClient({ followups: [resolved("new-resolution")], syncRunId: "run-1" });

    const result = await sendIncidentSyncStatus(state.client as never, "run-1", "2026-09-24T07:00:00.000Z");

    expect(telegram.sendToChat, JSON.stringify({ result, rows: state.rows })).toHaveBeenCalledTimes(1);
    expect(state.inserts.map((row) => row.followup_case_id)).toEqual(["new-resolution"]);
    expect(state.rows[0]).toMatchObject({ update_kind: "RESOLVED", status: "SENT" });
    expect(result.sentBatches).toBe(1);
    expect(result.resolved).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("sends only new resolved and active cases in a mixed batch", async () => {
    const state = makeClient({
      followups: [resolved("duplicate-resolution"), resolved("new-resolution"), active("active-case")],
      syncRunId: "run-1",
      priorSentResolved: ["duplicate-resolution"],
    });

    const result = await sendIncidentSyncStatus(state.client as never, "run-1", "2026-09-24T07:00:00.000Z");

    expect(telegram.sendToChat).toHaveBeenCalledTimes(1);
    const message = telegram.sendToChat.mock.calls[0][1] as string;
    expect(message).toContain("reason-new-resolution");
    expect(message).toContain("reason-active-case");
    expect(message).not.toContain("reason-duplicate-resolution");
    expect(state.inserts.map((row) => row.followup_case_id).sort()).toEqual(["active-case", "new-resolution"]);
    expect(state.rows.every((row) => row.status === "SENT")).toBe(true);
    expect(result.skipped).toBe(1);
  });

  it("does not send a duplicate resolved notice when the same run executes again", async () => {
    const state = makeClient({ followups: [resolved("once")], syncRunId: "run-1" });

    await sendIncidentSyncStatus(state.client as never, "run-1", "2026-09-24T07:00:00.000Z");
    await sendIncidentSyncStatus(state.client as never, "run-1", "2026-09-24T07:00:00.000Z");

    expect(telegram.sendToChat).toHaveBeenCalledTimes(1);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].status).toBe("SENT");
  });

  it("records SENT persistence failure without counting a persisted sent batch", async () => {
    const state = makeClient({
      followups: [resolved("persist-error")],
      syncRunId: "run-1",
      sentUpdateError: { code: "23505", message: "resolved notice already exists" },
    });

    const result = await sendIncidentSyncStatus(state.client as never, "run-1", "2026-09-24T07:00:00.000Z");

    expect(telegram.sendToChat).toHaveBeenCalledTimes(1);
    expect(result.sentBatches).toBe(0);
    expect(result.failed).toBe(1);
    expect(state.rows[0].status).toBe("FAILED");
    expect(state.rows[0].failure_reason).toContain("SENT status persistence failed");
  });

  it("keeps active-only behavior and does not query resolved-notice history", async () => {
    const state = makeClient({ followups: [active("active-only")], syncRunId: "run-1" });

    const result = await sendIncidentSyncStatus(state.client as never, "run-1", "2026-09-24T07:00:00.000Z");

    expect(state.resolvedLookupCount).toBe(0);
    expect(telegram.sendToChat).toHaveBeenCalledTimes(1);
    expect(state.rows[0]).toMatchObject({ update_kind: "ACTIVE", status: "SENT" });
    expect(result.active).toBe(1);
    expect(result.sentBatches).toBe(1);
    expect(result.failed).toBe(0);
  });
});
