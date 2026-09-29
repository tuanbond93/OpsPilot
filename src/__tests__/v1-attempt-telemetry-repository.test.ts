import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FollowupCaseRow } from "@/connectors/supabase/types";
import type { OperationalCohort } from "@/domain/operational-learning/checkpoint-policy";
import { SupabaseFollowupRepository, FollowupPersistenceError } from "@/repositories/supabase/SupabaseFollowupRepository";
import { withV1Attempt } from "@/observability/v1-attempt-telemetry";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const UPDATED_AT = "2026-09-24T01:00:00.000Z";

class FailureQuery {
  private operation: "select" | "insert" | "upsert" | "update" = "select";
  private payload: any;
  private filters: Array<(row: any) => boolean> = [];

  constructor(private readonly owner: FailureSupabase, private readonly table: string) {}
  select(_columns?: string) { return this; }
  insert(payload: any) { this.operation = "insert"; this.payload = payload; return this; }
  upsert(payload: any) { this.operation = "upsert"; this.payload = payload; return this; }
  update(payload: any) { this.operation = "update"; this.payload = payload; return this; }
  eq(key: string, value: any) { this.filters.push(row => row[key] === value); return this; }
  in(key: string, values: any[]) { this.filters.push(row => values.includes(row[key])); return this; }
  or(_value: string) { return this; }
  order(_key: string, _options?: any) { return this; }
  range(_start: number, _end: number) { return this; }
  maybeSingle() { return this.execute(true); }
  single() { return this.execute(true); }
  then(resolve: (value: any) => unknown, reject?: (error: unknown) => unknown) {
    return this.execute().then(resolve, reject);
  }

  private async execute(single = false): Promise<any> {
    const rows = this.owner.tables.get(this.table) || [];
    if (this.operation === "upsert" && this.table === "followup_case_members" && this.owner.failNextMemberWrite) {
      this.owner.failNextMemberWrite = false;
      return { data: null, error: { status: 500, code: "57014", message: "PRIVATE_ORDER_VALUE statement timeout" } };
    }

    if (this.operation === "insert" || this.operation === "upsert") {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
      for (const row of incoming) rows.push({ ...row });
      return { data: single ? rows.at(-1) || null : incoming.map(row => ({ ...row })), error: null };
    }
    if (this.operation === "update") {
      const selected = rows.filter(row => this.filters.every(filter => filter(row)));
      for (const row of selected) Object.assign(row, this.payload);
      return { data: single ? selected[0] || null : selected, error: null };
    }
    const selected = rows.filter(row => this.filters.every(filter => filter(row)));
    return { data: single ? selected[0] || null : selected, error: null };
  }
}

class FailureSupabase {
  tables = new Map<string, any[]>();
  failNextMemberWrite = false;
  from(table: string) {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return new FailureQuery(this, table);
  }
}

function cohort(): OperationalCohort {
  return {
    version: 1,
    day: "2026-09-24",
    capturedAt: UPDATED_AT,
    baselineCodes: ["ORDER-A"],
    lastCheckpoint: "2026-09-24:8",
    members: [{
      orderCode: "ORDER-A", customerId: "CUSTOMER-A", warehouseId: "WH-A", stage: "TRANSIT",
      status: "storing", observedAt: UPDATED_AT, readyAt: null, source: "rillnet",
      dueAt: null, baselineStatus: "storing",
    }],
  };
}

function parent(): FollowupCaseRow {
  return {
    id: CASE_ID, incident_id: "incident-a", incident_key: "warehouse-a:KHO_TON",
    current_state: "FOLLOWING_UP", first_detected_at: UPDATED_AT, last_checked_at: UPDATED_AT,
    baseline_affected_order_count: 1, latest_affected_order_count: 1, current_progress_percent: 0,
    current_assessment: "insufficient_data", current_rillnet_status_signature: "", updated_at: UPDATED_AT,
    cohort_version: 1, member_generation_id: null, operational_cohort: cohort(),
  } as FollowupCaseRow;
}

afterEach(() => vi.restoreAllMocks());

describe("V1 repository error-path telemetry", () => {
  it("captures a real member upsert failure while preserving the original error and writes", async () => {
    const client = new FailureSupabase();
    const caseRow = parent();
    client.tables.set("followup_cases", [{ ...caseRow }]);
    client.failNextMemberWrite = true;
    const beforeCases = structuredClone(client.tables.get("followup_cases"));
    const messages: string[] = [];
    vi.spyOn(console, "info").mockImplementation(message => { messages.push(message); });
    const repository = new SupabaseFollowupRepository(client as unknown as SupabaseClient);
    const context = {
      sync_run_id: "run-telemetry", work_unit_id: "unit-telemetry", chunk_index: 0,
      attempt: 2, request_id: "request-telemetry", input_source: "cursor.metadata.chunkOrders",
      input_order_count: 1, input_bytes: 123,
    };

    await expect(withV1Attempt(context, () => repository.persistOperationalCohortGenerations([caseRow], RUN_ID)))
      .rejects.toBeInstanceOf(FollowupPersistenceError);

    const trace = JSON.parse(messages.find(message => message.includes('"operation_name":"followup_case_members_upsert"'))!);
    expect(trace).toMatchObject({ sync_run_id: "run-telemetry", work_unit_id: "unit-telemetry",
      attempt: 2, operation_name: "followup_case_members_upsert", table_or_rpc: "followup_case_members",
      success: false, error_code: "57014", error_message: "statement timeout" });
    expect(trace.duration_ms).toBeGreaterThanOrEqual(0);
    expect(messages.join("\n")).not.toContain("PRIVATE_ORDER_VALUE");

    expect(client.tables.get("followup_cases")).toEqual(beforeCases);
    expect(client.tables.get("followup_case_members") || []).toHaveLength(0);
    expect(client.tables.get("followup_case_cohort_archive") || []).toHaveLength(1);
    expect(client.tables.get("followup_case_member_generations") || []).toHaveLength(1);
    expect(client.failNextMemberWrite).toBe(false);
  });
});
