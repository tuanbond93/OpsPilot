import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FollowupCaseRow } from "@/connectors/supabase/types";
import type { OperationalCohort } from "@/domain/operational-learning/checkpoint-policy";
import { SupabaseFollowupRepository } from "@/repositories/supabase/SupabaseFollowupRepository";
import { runFollowupCohortBackfillBatch } from "@/services/followup-cohort-backfill";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const OLD_RUN_ID = "33333333-3333-4333-8333-333333333333";
const UPDATED_AT = "2026-09-24T01:00:00.000Z";

class MemoryQuery {
  private operation: "select" | "insert" | "upsert" | "update" = "select";
  private payload: any;
  private options: any;
  private filters: Array<(row: any) => boolean> = [];
  private offset = 0;
  private end = Number.POSITIVE_INFINITY;
  private ignoreDupes = false;

  constructor(private readonly owner: MemorySupabase, private readonly table: string) {}
  select(_columns?: string) { return this; }
  insert(payload: any) { this.operation = "insert"; this.payload = payload; return this; }
  upsert(payload: any, options?: any) { this.operation = "upsert"; this.payload = payload; this.options = options; this.ignoreDupes = Boolean(options?.ignoreDuplicates); return this; }
  update(payload: any) { this.operation = "update"; this.payload = payload; return this; }
  eq(key: string, value: any) { this.filters.push((row) => row[key] === value); return this; }
  in(key: string, values: any[]) { this.filters.push((row) => values.includes(row[key])); return this; }
  is(key: string, value: any) { this.filters.push((row) => row[key] === value); return this; }
  neq(key: string, value: any) { this.filters.push((row) => row[key] !== value); return this; }
  not(_key: string, _operator: string, _value: any) { return this; }
  gt(key: string, value: any) { this.filters.push((row) => row[key] > value); return this; }
  or(_filter: string) { return this; }
  order(_key: string, _options?: any) { return this; }
  limit(_limit: number) { return this; }
  range(start: number, end: number) { this.offset = start; this.end = end + 1; return this; }
  maybeSingle() { return this.execute(true); }
  single() { return this.execute(true); }
  then(resolve: (value: any) => unknown, reject?: (error: unknown) => unknown) { return this.execute().then(resolve, reject); }

  private async execute(single = false): Promise<any> {
    const rows = this.owner.tables.get(this.table) || [];
    if (this.operation === "upsert" && this.table === "followup_case_members" && this.owner.failNextMemberWrite) {
      this.owner.failNextMemberWrite = false;
      return { data: null, error: { code: "57014", message: "simulated interrupted member chunk" } };
    }
    if (this.operation === "upsert" && this.table === "followup_case_members") this.owner.memberUpsertCalls++;
    let selected: any[];
    if (this.operation === "insert" || this.operation === "upsert") {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
      selected = [];
      for (const row of incoming) {
        if (this.table === "followup_cases" && !row.id) row.id = CASE_ID;
        const key = this.table === "followup_case_members"
          ? `${row.followup_case_id}:${row.generation_id}:${row.order_code}`
          : this.table === "followup_case_member_generations"
            ? `${row.followup_case_id}:${row.generation_id}`
            : this.table === "followup_case_cohort_archive" ? row.followup_case_id : row.id;
        const identity = (candidate: any) => this.table === "followup_case_members"
          ? `${candidate.followup_case_id}:${candidate.generation_id}:${candidate.order_code}`
          : this.table === "followup_case_member_generations"
            ? `${candidate.followup_case_id}:${candidate.generation_id}`
            : this.table === "followup_case_cohort_archive" ? candidate.followup_case_id : candidate.id;
        const existingIndex = rows.findIndex((candidate) => identity(candidate) === key);
        if (existingIndex >= 0 && this.operation === "upsert" && !this.ignoreDupes) {
          rows[existingIndex] = { ...rows[existingIndex], ...row };
          selected.push(rows[existingIndex]);
        } else if (existingIndex >= 0 && this.ignoreDupes) {
          continue;
        } else {
          rows.push({ ...row });
          selected.push(rows[rows.length - 1]);
        }
      }
    } else if (this.operation === "update") {
      selected = rows.filter((row) => this.filters.every((filter) => filter(row)));
      for (const row of selected) Object.assign(row, this.payload);
    } else {
      selected = rows.filter((row) => this.filters.every((filter) => filter(row)));
    }
    if (this.operation === "select") selected = selected.slice(this.offset, this.end);
    return { data: single ? selected[0] || null : selected, error: null };
  }
}

class MemorySupabase {
  tables = new Map<string, any[]>();
  failNextMemberWrite = false;
  memberUpsertCalls = 0;
  from(table: string) {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return new MemoryQuery(this, table);
  }
}

function cohort(): OperationalCohort {
  return {
    version: 1,
    day: "2026-09-24",
    capturedAt: UPDATED_AT,
    baselineCodes: ["ORDER-A", "ORDER-B"],
    lastCheckpoint: "2026-09-24:8",
    members: ["ORDER-A", "ORDER-B"].map((orderCode) => ({
      orderCode,
      customerId: "CUSTOMER-A",
      warehouseId: "WH-A",
      stage: "TRANSIT",
      status: "storing",
      observedAt: UPDATED_AT,
      readyAt: null,
      source: "rillnet",
      dueAt: null,
      baselineStatus: "storing",
    })),
  };
}

function parentRow(): FollowupCaseRow {
  return {
    id: CASE_ID,
    incident_id: "incident-a",
    incident_key: "warehouse-a:KHO_TON",
    current_state: "FOLLOWING_UP",
    first_detected_at: UPDATED_AT,
    last_checked_at: UPDATED_AT,
    baseline_affected_order_count: 2,
    latest_affected_order_count: 2,
    current_progress_percent: 0,
    current_assessment: "insufficient_data",
    current_rillnet_status_signature: "",
    updated_at: UPDATED_AT,
    cohort_version: 1,
    member_generation_id: OLD_RUN_ID,
    operational_cohort: cohort(),
  };
}

describe("normalized follow-up repository write path", () => {
  it("archives the complete legacy verification map before filtering active V2 members", async () => {
    const client = new MemorySupabase();
    const legacy = cohort();
    legacy.verification = {
      source: "ghn_internal_order_logs",
      checkedAt: UPDATED_AT,
      failures: {
        "ORDER-A": "TRACKING_UNAVAILABLE",
        "PRUNED-ORDER": "BUDGET_DEFERRED",
      },
    };
    const original = structuredClone(legacy);
    client.tables.set("followup_cases", [{ ...parentRow(), cohort_version: 1, member_generation_id: null, operational_cohort: legacy }]);

    const result = await runFollowupCohortBackfillBatch(client as unknown as SupabaseClient, { apply: true, limit: 1 });

    expect(result).toMatchObject({ backfilled: 1, failed: 0 });
    expect(client.tables.get("followup_case_cohort_archive")?.[0].original_operational_cohort)
      .toEqual(original);
    expect(client.tables.get("followup_cases")?.[0].operational_cohort.verification.failureCount).toBe(1);
    expect(client.tables.get("followup_case_members")?.map((row) => [row.order_code, row.verification_failure]))
      .toEqual([["ORDER-A", "TRACKING_UNAVAILABLE"], ["ORDER-B", null]]);
    expect(legacy).toEqual(original);
  });

  it("leaves the old pointer authoritative on a partial write and safely resumes the same generation", async () => {
    const client = new MemorySupabase();
    client.tables.set("followup_cases", [parentRow()]);
    client.failNextMemberWrite = true;
    const repository = new SupabaseFollowupRepository(client as unknown as SupabaseClient);
    const mutation: any = {
      id: CASE_ID,
      updated_at: UPDATED_AT,
      incident_id: "incident-a",
      incident_key: "warehouse-a:KHO_TON",
      current_state: "FOLLOWING_UP",
      first_detected_at: UPDATED_AT,
      last_checked_at: "2026-09-24T03:00:00.000Z",
      baseline_affected_order_count: 2,
      latest_affected_order_count: 2,
      current_progress_percent: 0,
      current_assessment: "insufficient_data",
      current_rillnet_status_signature: "",
      cohort_version: 1,
      member_generation_id: OLD_RUN_ID,
      operational_cohort: cohort(),
    };

    await expect(repository.persistOperationalCohortGenerations([mutation], RUN_ID)).rejects.toThrow("simulated interrupted member chunk");
    expect(client.tables.get("followup_cases")![0].member_generation_id).toBe(OLD_RUN_ID);
    expect(client.tables.get("followup_cases")![0].cohort_version).toBe(1);
    expect(client.tables.get("followup_case_members")).toEqual([]);

    const result = await repository.persistOperationalCohortGenerations([mutation], RUN_ID);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: CASE_ID, incident_id: "incident-a", incident_key: "warehouse-a:KHO_TON" });
    expect(client.tables.get("followup_cases")![0].cohort_version).toBe(2);
    expect(client.tables.get("followup_cases")![0].member_generation_id).toBe(RUN_ID);
    expect(client.tables.get("followup_case_members")).toHaveLength(2);
    expect(client.tables.get("followup_case_cohort_archive")).toHaveLength(1);
  });

  it("keeps a new case state-neutral and resumes its unpointed generation after interruption", async () => {
    const client = new MemorySupabase();
    client.failNextMemberWrite = true;
    const repository = new SupabaseFollowupRepository(client as unknown as SupabaseClient);
    const mutation: any = {
      incident_id: "incident-a",
      incident_key: "warehouse-a:KHO_TON",
      current_state: "FOLLOWING_UP",
      first_detected_at: UPDATED_AT,
      last_checked_at: "2026-09-24T03:00:00.000Z",
      baseline_affected_order_count: 2,
      latest_affected_order_count: 2,
      current_progress_percent: 0,
      current_assessment: "insufficient_data",
      current_rillnet_status_signature: "",
      operational_cohort: cohort(),
    };

    await expect(repository.persistOperationalCohortGenerations([mutation], RUN_ID)).rejects.toThrow("simulated interrupted member chunk");
    const [staged] = client.tables.get("followup_cases")!;
    expect(staged).toMatchObject({
      current_state: "NEW",
      operational_cohort: null,
      cohort_version: null,
      member_generation_id: null,
    });

    const loaded = await repository.getOperationalCasesPage();
    expect(loaded.cases[0].operational_cohort).toBeNull();
    const retryMutation = { ...mutation, id: staged.id, updated_at: staged.updated_at };
    await repository.persistOperationalCohortGenerations([retryMutation], RUN_ID);

    expect(client.tables.get("followup_cases")).toHaveLength(1);
    expect(client.tables.get("followup_cases")![0]).toMatchObject({
      current_state: "FOLLOWING_UP",
      cohort_version: 2,
      member_generation_id: RUN_ID,
    });
    expect(client.tables.get("followup_case_members")).toHaveLength(2);
    expect(client.tables.get("followup_case_cohort_archive")).toHaveLength(1);
  });

  it("does not mutate a generation after its parent pointer already committed it", async () => {
    const client = new MemorySupabase();
    client.tables.set("followup_cases", [parentRow()]);
    const repository = new SupabaseFollowupRepository(client as unknown as SupabaseClient);
    await repository.persistOperationalCohortGenerations([{
      id: CASE_ID,
      updated_at: UPDATED_AT,
      incident_id: "incident-a",
      incident_key: "warehouse-a:KHO_TON",
      current_state: "FOLLOWING_UP",
      first_detected_at: UPDATED_AT,
      last_checked_at: "2026-09-24T03:00:00.000Z",
      baseline_affected_order_count: 2,
      latest_affected_order_count: 2,
      current_progress_percent: 0,
      current_assessment: "insufficient_data",
      current_rillnet_status_signature: "",
      cohort_version: 1,
      member_generation_id: OLD_RUN_ID,
      operational_cohort: cohort(),
    }], RUN_ID);

    const committed = (await repository.getCaseById(CASE_ID))!;
    const writesAfterCommit = client.memberUpsertCalls;
    await repository.persistOperationalCohortGenerations([{
      ...committed,
      current_state: "FOLLOWING_UP",
      operational_cohort: committed.operational_cohort,
    }], RUN_ID);
    expect(client.memberUpsertCalls).toBe(writesAfterCommit);

    const changed = structuredClone(committed.operational_cohort!) as OperationalCohort;
    changed.members[0].status = "delivered";
    await expect(repository.persistOperationalCohortGenerations([{
      ...committed,
      current_state: "FOLLOWING_UP",
      operational_cohort: changed,
    }], RUN_ID)).rejects.toThrow("FOLLOWUP_MEMBER_GENERATION_FIELD_MISMATCH:ORDER-A:status");
    expect(client.memberUpsertCalls).toBe(writesAfterCommit);
    expect(client.tables.get("followup_case_members")![0].status).toBe("storing");
  });
});
