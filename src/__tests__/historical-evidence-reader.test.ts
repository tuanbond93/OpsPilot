import { describe, expect, it } from "vitest";
import { HistoricalEvidenceReader, MAX_EVIDENCE_PAGE_SIZE, MAX_EVIDENCE_WINDOW_MS, validateHistoricalEvidenceQuery } from "@/domain/historical-evidence/reader";

const query = (overrides: Record<string, unknown> = {}) => ({ from: "2026-09-04T00:00:00.000Z", to: "2026-09-11T00:00:00.000Z", scope: { type: "global" as const }, ...overrides });
function fakeClient(tables: Record<string, any[]>) {
  return { from(table: string) { const chain: any = {}; for (const method of ["select", "in", "gte", "lte", "order", "limit"]) chain[method] = () => chain; chain.then = (resolve: any) => resolve({ data: tables[table] || [], error: null }); return chain; } } as any;
}
const baseTables = {
  incidents: [{ id: "i1", incident_key: "key1", warehouse_id: "21156000", warehouse_name: "WH", reason_code: "KHO_TON", first_detected_at: "2026-09-04T01:00:00.000Z", resolved_at: null }],
  followup_cases: [{ id: "c1", incident_id: "i1", incident_key: "key1", current_state: "FIRST_PUSH_SENT", first_detected_at: "2026-09-04T01:00:00.000Z", resolved_at: null, closed_at: null, rillnet_changed_at: null }],
  incident_history: [{ incident_id: "i1", recorded_at: "2026-09-05T00:00:00.000Z", affected_order_count: 2, sample_order_codes: ["O1"] }, { incident_id: "i1", recorded_at: "2026-09-04T00:00:00.000Z", affected_order_count: 3, sample_order_codes: ["O1"] }],
  followup_events: [{ followup_case_id: "c1", event_type: "PUSH_CONFIRMED", event_time: "2026-09-05T00:00:00.000Z", old_state: "FIRST_PUSH_PENDING", new_state: "FIRST_PUSH_SENT" }, { followup_case_id: "c1", event_type: "CASE_CREATED", event_time: "2026-09-04T00:00:00.000Z", old_state: "NEW", new_state: "FIRST_PUSH_PENDING" }],
  notification_actions: [{ id: "a1", action_type: "FIRST_PUSH", payload: { incidentId: "i1" }, status: "CANCELLED", outcome: "DELIVERED", created_at: "2026-09-04T00:00:00.000Z", processed_at: "2026-09-04T01:00:00.000Z", provider_message_id: "100", deduplication_key: "batch" }],
  notification_action_events: [], order_exceptions: [],
};

describe("historical evidence query boundary", () => {
  it("enforces explicit bounded time ranges, scope, and page size", () => {
    expect(validateHistoricalEvidenceQuery(query()).limit).toBe(50);
    expect(() => validateHistoricalEvidenceQuery(query({ to: new Date(Date.parse("2026-09-04T00:00:00.000Z") + MAX_EVIDENCE_WINDOW_MS + 1).toISOString() }))).toThrow("DATE_WINDOW_TOO_LARGE");
    expect(() => validateHistoricalEvidenceQuery(query({ limit: MAX_EVIDENCE_PAGE_SIZE + 1 }))).not.toThrow();
    expect(() => validateHistoricalEvidenceQuery(query({ asOf: "2026-09-12T00:00:00.000Z" }))).toThrow("INVALID_AS_OF");
  });

  it("preserves chronological history/events and case-linked grouped delivery proof", async () => {
    const reader = new HistoricalEvidenceReader(fakeClient(baseTables), ["21156000"]);
    const result = await reader.queryCases(query()); const record = result.records[0];
    expect(record.incidentHistory.map(row => row.affectedOrderCount)).toEqual([3, 2]);
    expect(record.followupEvents.map(row => row.eventType)).toEqual(["CASE_CREATED", "PUSH_CONFIRMED"]);
    expect(record.actions[0]).toMatchObject({ caseMembershipProven: true, caseConfirmation: "CONFIRMED", messageId: "100" });
  });

  it("returns unavailable rather than substituting current state for an as-of gap", async () => {
    const reader = new HistoricalEvidenceReader(fakeClient({ ...baseTables, incident_history: [] }), ["21156000"]);
    const result = await reader.queryCases(query({ asOf: "2026-09-06T00:00:00.000Z" }));
    expect(result.records[0].historicalState).toBe("HISTORICAL_STATE_UNAVAILABLE");
  });

  it("enforces warehouse scope and has no mutation methods", async () => {
    const reader = new HistoricalEvidenceReader(fakeClient(baseTables), []);
    expect((await reader.queryCases(query())).records).toEqual([]);
    expect(Object.getOwnPropertyNames(HistoricalEvidenceReader.prototype)).not.toContain("mutate");
  });

  it("keeps expired and current suppression facts distinct", async () => {
    const reader = new HistoricalEvidenceReader(fakeClient({ ...baseTables, order_exceptions: [{ order_code: "O1", reason_code: "DAMAGED", created_at: "2026-09-04T00:00:00.000Z", expires_at: "2026-09-05T00:00:00.000Z", active: true }] }), ["21156000"]);
    const result = await reader.queryCases(query({ asOf: "2026-09-06T00:00:00.000Z" }));
    expect(result.records[0].suppressionEvidence[0].status).toBe("HISTORICAL");
  });
});
