import { describe, expect, it } from "vitest";
import { sendIncidentSyncStatus } from "@/services/telegram-incident-status";

describe("checkpoint incident-status batching regression", () => {
  it("bounds PostgREST incident-id filters for a 235-incident checkpoint", async () => {
    const followups = Array.from({ length: 235 }, (_, index) => ({
      id: `case-${index}`,
      incident_id: `incident-${index}`,
      current_state: "OPEN",
      latest_affected_order_count: 1,
      resolved_at: null,
    }));
    const incidentBatchSizes: number[] = [];
    const historyBatchSizes: number[] = [];

    const client = {
      from(table: string) {
        if (table === "followup_cases") {
          return { select: () => ({ limit: async () => ({ data: followups, error: null }) }) };
        }
        if (table === "telegram_pilot_topics") {
          return {
            select: () => ({
              eq: () => ({ eq: async () => ({ data: [], error: null }) }),
            }),
          };
        }
        if (table === "incidents") {
          return {
            select: () => ({
              in: async (_column: string, ids: string[]) => {
                incidentBatchSizes.push(ids.length);
                return {
                  data: ids.map((id) => ({
                    id,
                    warehouse_id: "20121005",
                    warehouse_name: "(LCH) Nậm Mạ",
                    reason_name: "Kho tồn",
                  })),
                  error: null,
                };
              },
            }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
      async rpc(_name: string, args: { p_incident_ids: string[] }) {
        historyBatchSizes.push(args.p_incident_ids.length);
        return { data: [], error: null };
      },
    };

    const result = await sendIncidentSyncStatus(client as never, "sync-1", "2026-09-09T01:00:00.000Z");

    expect(incidentBatchSizes).toEqual([100, 100, 35]);
    expect(historyBatchSizes).toEqual([100, 100, 35]);
    expect(result.active).toBe(235);
  });
});
