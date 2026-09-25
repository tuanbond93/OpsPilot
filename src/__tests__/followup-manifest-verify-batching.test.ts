import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FollowupCaseRow } from "@/connectors/supabase/types";
import type { OperationalCohort } from "@/domain/operational-learning/checkpoint-policy";
import {
  FOLLOWUP_MEMBER_MAX_ROWS,
  FOLLOWUP_MEMBER_MAX_SERIALIZED_BYTES,
  planFollowupMemberWriteChunks,
  type FollowupCaseMemberRow,
} from "@/domain/operational-learning/normalized-followup-members";
import {
  SupabaseFollowupRepository,
  MANIFEST_VERIFY_BATCH_SIZE,
  FollowupPersistenceError,
} from "@/repositories/supabase/SupabaseFollowupRepository";
import { hydrateFollowupCaseRows } from "@/repositories/supabase/followup-case-cohort";

const RUN_ID = "22222222-2222-4222-8222-222222222222";
const FAILED_20H_GENERATION_ID = "9761bdc2-baff-46f1-9456-f881284663fb";
const UPDATED_AT = "2026-09-24T01:00:00.000Z";

interface ManifestVerifyQueryRecord {
  generationId: string;
  ids: string[];
}

class InstrumentedMemoryQuery {
  private operation: "select" | "insert" | "upsert" | "update" = "select";
  private payload: any;
  private options: any;
  private filters: Array<(row: any) => boolean> = [];
  private offset = 0;
  private end = Number.POSITIVE_INFINITY;
  private ignoreDupes = false;
  private selectedColumns: string = "";
  private currentEqGenerationId: string | null = null;
  private currentInCaseIds: string[] | null = null;

  constructor(private readonly owner: InstrumentedMemorySupabase, private readonly table: string) {}

  select(columns?: string) { this.selectedColumns = columns || "*"; return this; }
  insert(payload: any) { this.operation = "insert"; this.payload = payload; return this; }
  upsert(payload: any, options?: any) {
    this.operation = "upsert";
    this.payload = payload;
    this.options = options;
    this.ignoreDupes = Boolean(options?.ignoreDuplicates);
    return this;
  }
  update(payload: any) { this.operation = "update"; this.payload = payload; return this; }
  eq(key: string, value: any) {
    if (key === "generation_id") this.currentEqGenerationId = value;
    this.filters.push((row) => row[key] === value);
    return this;
  }
  in(key: string, values: any[]) {
    if (key === "followup_case_id") this.currentInCaseIds = [...values];
    this.filters.push((row) => values.includes(row[key]));
    return this;
  }
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
  then(resolve: (value: any) => unknown, reject?: (error: unknown) => unknown) {
    return this.execute().then(resolve, reject);
  }

  private async execute(single = false): Promise<any> {
    const rows = this.owner.tables.get(this.table) || [];

    if (this.operation === "select" && this.table === "followup_case_member_generations" && this.currentInCaseIds) {
      if (this.selectedColumns.includes("expected_member_count")) {
        const verifyReq: ManifestVerifyQueryRecord = {
          generationId: this.currentEqGenerationId || "",
          ids: [...this.currentInCaseIds],
        };
        this.owner.manifestVerifyQueries.push(verifyReq);
        const reqIndex = this.owner.manifestVerifyQueries.length - 1;

        if (this.owner.failManifestVerifyBatchIndex !== null && reqIndex === this.owner.failManifestVerifyBatchIndex) {
          return {
            data: null,
            error: {
              status: 400,
              code: "PGRST100",
              message: "simulated manifest verify batch failure",
              details: "header/query error",
              hint: "reduce request size",
            },
          };
        }
      }
    }

    if (this.operation === "upsert" && this.table === "followup_case_members") {
      this.owner.memberUpsertCalls++;
      if (this.owner.failNextMemberWrite) {
        this.owner.failNextMemberWrite = false;
        return {
          data: null,
          error: {
            status: 500,
            code: "57014",
            message: "simulated interrupted member chunk",
            details: "statement timeout",
            hint: null,
          },
        };
      }
    }

    let selected: any[];
    if (this.operation === "insert" || this.operation === "upsert") {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
      selected = [];
      for (const row of incoming) {
        if (this.table === "followup_cases" && !row.id) {
          row.id = `case-gen-${rows.length + 1}`;
        }
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

class InstrumentedMemorySupabase {
  tables = new Map<string, any[]>();
  manifestVerifyQueries: ManifestVerifyQueryRecord[] = [];
  failManifestVerifyBatchIndex: number | null = null;
  failNextMemberWrite = false;
  memberUpsertCalls = 0;

  from(table: string) {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return new InstrumentedMemoryQuery(this, table);
  }
}

function createCohort(memberCount: number = 2): OperationalCohort {
  const members = Array.from({ length: memberCount }, (_, i) => ({
    orderCode: `ORDER-${i + 1}`,
    customerId: `CUST-${i + 1}`,
    warehouseId: "WH-1",
    stage: "TRANSIT" as const,
    status: "storing",
    observedAt: UPDATED_AT,
    readyAt: null,
    source: "rillnet" as const,
    dueAt: null,
    baselineStatus: "storing",
  }));
  return {
    version: 1,
    day: "2026-09-24",
    capturedAt: UPDATED_AT,
    baselineCodes: members.map((m) => m.orderCode),
    lastCheckpoint: "2026-09-24:8",
    members,
  };
}

function makeCase(id: string, incidentKey: string, memberCount: number = 2): FollowupCaseRow {
  return {
    id,
    incident_id: `inc-${id}`,
    incident_key: incidentKey,
    current_state: "FOLLOWING_UP",
    first_detected_at: UPDATED_AT,
    last_checked_at: UPDATED_AT,
    baseline_affected_order_count: memberCount,
    latest_affected_order_count: memberCount,
    current_progress_percent: 0,
    current_assessment: "insufficient_data",
    current_rillnet_status_signature: "",
    updated_at: UPDATED_AT,
    cohort_version: 1,
    member_generation_id: null,
    operational_cohort: createCohort(memberCount),
  };
}

describe("Production 20H Root-Cause Patch: Manifest Verification Batching & Diagnostics", () => {
  it("A. 1091 manifests: verification produces exactly 11 requests, <=100 IDs each, all 1091 returned, parity PASS", async () => {
    const client = new InstrumentedMemorySupabase();
    const cases: FollowupCaseRow[] = [];
    for (let i = 1; i <= 1091; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      cases.push(makeCase(id, `wh-${i}:KHO_TON`, 2));
    }
    client.tables.set("followup_cases", cases.map((c) => ({ ...c })));
    const repo = new SupabaseFollowupRepository(client as unknown as SupabaseClient);

    const persisted = await repo.persistOperationalCohortGenerations(
      cases.map((c) => ({ ...c })),
      RUN_ID
    );

    expect(persisted).toHaveLength(1091);
    expect(client.manifestVerifyQueries).toHaveLength(11);
    for (let b = 0; b < client.manifestVerifyQueries.length; b++) {
      const q = client.manifestVerifyQueries[b];
      expect(q.ids.length).toBeLessThanOrEqual(MANIFEST_VERIFY_BATCH_SIZE);
      expect(q.ids.length).toBeGreaterThan(0);
      if (b < 10) {
        expect(q.ids.length).toBe(100);
      } else {
        expect(q.ids.length).toBe(91); // 1091 - 1000
      }
    }

    const totalVerifiedIds = client.manifestVerifyQueries.reduce((sum, q) => sum + q.ids.length, 0);
    expect(totalVerifiedIds).toBe(1091);

    const manifests = client.tables.get("followup_case_member_generations") || [];
    expect(manifests).toHaveLength(1091);
    expect(manifests.every((m) => m.generation_status === "COMMITTED")).toBe(true);
  });

  it("B. Missing manifest: parity fails and member writes are NOT reached", async () => {
    const client = new InstrumentedMemorySupabase();
    const cases = [
      makeCase("00000000-0000-4000-8000-000000000001", "wh-1:KHO_TON", 2),
      makeCase("00000000-0000-4000-8000-000000000002", "wh-2:KHO_TON", 2),
    ];
    client.tables.set("followup_cases", cases.map((c) => ({ ...c })));
    const repo = new SupabaseFollowupRepository(client as unknown as SupabaseClient);

    // Simulate manifest missing for case 2 by deleting it from member_generations after registration
    const originalFrom = client.from.bind(client);
    let upsertCount = 0;
    client.from = (table: string) => {
      const query = originalFrom(table);
      if (table === "followup_case_member_generations") {
        const origUpsert = query.upsert.bind(query);
        query.upsert = (payload: any, options?: any) => {
          upsertCount++;
          // Only register case 1, drop case 2
          const filtered = Array.isArray(payload)
            ? payload.filter((r) => r.followup_case_id === cases[0].id)
            : payload;
          return origUpsert(filtered, options);
        };
      }
      return query;
    };

    await expect(
      repo.persistOperationalCohortGenerations(cases.map((c) => ({ ...c })), RUN_ID)
    ).rejects.toThrow("FOLLOWUP_MEMBER_GENERATION_MANIFEST_MISMATCH");

    // Member writes must NOT have been reached
    expect(client.memberUpsertCalls).toBe(0);
    expect(client.tables.get("followup_case_members") || []).toHaveLength(0);
  });

  it("C. Batch error: batch failure captures structured diagnostics and member writes are NOT reached", async () => {
    const client = new InstrumentedMemorySupabase();
    const cases: FollowupCaseRow[] = [];
    // 700 cases = 7 batches (batch indices 0 to 6)
    for (let i = 1; i <= 700; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      cases.push(makeCase(id, `wh-${i}:KHO_TON`, 1));
    }
    client.tables.set("followup_cases", cases.map((c) => ({ ...c })));
    const repo = new SupabaseFollowupRepository(client as unknown as SupabaseClient);

    // Fail batch index 5 (6th batch)
    client.failManifestVerifyBatchIndex = 5;

    let caughtError: any = null;
    try {
      await repo.persistOperationalCohortGenerations(cases.map((c) => ({ ...c })), RUN_ID);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(FollowupPersistenceError);
    expect(caughtError.operation).toBe("manifest_verify");
    expect(caughtError.table).toBe("followup_case_member_generations");
    expect(caughtError.generationId).toBe(RUN_ID);
    expect(caughtError.batchIndex).toBe(5);
    expect(caughtError.batchCount).toBe(7);
    expect(caughtError.caseCount).toBe(100);
    expect(caughtError.status).toBe(400);
    expect(caughtError.code).toBe("PGRST100");
    expect(caughtError.message).toContain("simulated manifest verify batch failure");

    // Member writes are NOT reached
    expect(client.memberUpsertCalls).toBe(0);
    expect(client.tables.get("followup_case_members") || []).toHaveLength(0);
  });

  it("D. Small cohort (<=100 cases): exactly one verify request and unchanged semantics", async () => {
    const client = new InstrumentedMemorySupabase();
    const cases: FollowupCaseRow[] = [];
    for (let i = 1; i <= 45; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      cases.push(makeCase(id, `wh-${i}:KHO_TON`, 2));
    }
    client.tables.set("followup_cases", cases.map((c) => ({ ...c })));
    const repo = new SupabaseFollowupRepository(client as unknown as SupabaseClient);

    const persisted = await repo.persistOperationalCohortGenerations(
      cases.map((c) => ({ ...c })),
      RUN_ID
    );

    expect(persisted).toHaveLength(45);
    expect(client.manifestVerifyQueries).toHaveLength(1);
    expect(client.manifestVerifyQueries[0].ids).toHaveLength(45);
    expect(client.manifestVerifyQueries[0].generationId).toBe(RUN_ID);

    const manifests = client.tables.get("followup_case_member_generations") || [];
    expect(manifests).toHaveLength(45);
    expect(manifests.every((m) => m.generation_status === "COMMITTED")).toBe(true);
  });

  it("E. Existing member persistence: 53,461-member-scale chunk planner remains strictly bounded", () => {
    const totalMembers = 53461;
    const allMembers: FollowupCaseMemberRow[] = [];
    for (let i = 0; i < totalMembers; i++) {
      allMembers.push({
        followup_case_id: `case-${Math.floor(i / 49)}`,
        generation_id: RUN_ID,
        source_sync_run_id: RUN_ID,
        order_code: `ORDER-${i}`,
        customer_id: `CUST-${i % 500}`,
        warehouse_id: "WH-1",
        stage: "TRANSIT",
        status: "storing",
        observed_at: UPDATED_AT,
        ready_at: null,
        source: "rillnet",
        baseline_status: "storing",
        is_baseline: true,
        due_at: null,
        last_reminder_at: null,
        last_reminder_status: null,
        completed_at: null,
        member_active: true,
        verification_failure: null,
      });
    }

    const chunks = planFollowupMemberWriteChunks(allMembers);
    expect(chunks.length).toBeGreaterThan(1);

    let aggregatedCount = 0;
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(FOLLOWUP_MEMBER_MAX_ROWS);
      const byteSize = Buffer.byteLength(JSON.stringify(chunk), "utf8");
      expect(byteSize).toBeLessThanOrEqual(FOLLOWUP_MEMBER_MAX_SERIALIZED_BYTES);
      aggregatedCount += chunk.length;
    }
    expect(aggregatedCount).toBe(totalMembers);
  }, 60_000);

  it("F. Pointer safety: no pointer flip before member parity succeeds", async () => {
    const client = new InstrumentedMemorySupabase();
    const testCase = makeCase("00000000-0000-4000-8000-000000000001", "wh-1:KHO_TON", 2);
    client.tables.set("followup_cases", [{ ...testCase }]);
    client.failNextMemberWrite = true;
    const repo = new SupabaseFollowupRepository(client as unknown as SupabaseClient);

    await expect(
      repo.persistOperationalCohortGenerations([{ ...testCase }], RUN_ID)
    ).rejects.toThrow("simulated interrupted member chunk");

    // Parent case must NOT have its pointer flipped to RUN_ID
    const storedCase = client.tables.get("followup_cases")![0];
    expect(storedCase.member_generation_id).toBeNull();
    expect(storedCase.cohort_version).toBe(1);
  });

  it("G. Previous failed generation: old PREPARING generation does not contaminate new generation", async () => {
    const client = new InstrumentedMemorySupabase();
    const caseId = "00000000-0000-4000-8000-000000000001";
    const testCase = makeCase(caseId, "wh-1:KHO_TON", 2);
    client.tables.set("followup_cases", [{ ...testCase }]);

    // Seed old failed 20H PREPARING generation
    client.tables.set("followup_case_member_generations", [{
      followup_case_id: caseId,
      generation_id: FAILED_20H_GENERATION_ID,
      source_sync_run_id: FAILED_20H_GENERATION_ID,
      expected_member_count: 2,
      generation_status: "PREPARING",
      committed_at: null,
    }]);

    const repo = new SupabaseFollowupRepository(client as unknown as SupabaseClient);
    const persisted = await repo.persistOperationalCohortGenerations([{ ...testCase }], RUN_ID);

    expect(persisted).toHaveLength(1);
    const allGenerations = client.tables.get("followup_case_member_generations") || [];
    expect(allGenerations).toHaveLength(2);

    const oldGen = allGenerations.find((g) => g.generation_id === FAILED_20H_GENERATION_ID);
    expect(oldGen?.generation_status).toBe("PREPARING");
    expect(oldGen?.committed_at).toBeNull();

    const newGen = allGenerations.find((g) => g.generation_id === RUN_ID);
    expect(newGen?.generation_status).toBe("COMMITTED");
    expect(newGen?.committed_at).toBeTruthy();
  });

  it("H. CLOSED case regression: previously fixed CLOSED stable identity reuse remains PASS", async () => {
    const client = new InstrumentedMemorySupabase();
    const caseId = "00000000-0000-4000-8000-000000000001";
    const closedCase = {
      ...makeCase(caseId, "wh-closed:KHO_TON", 2),
      current_state: "CLOSED" as const,
      closed_at: UPDATED_AT,
    };
    client.tables.set("followup_cases", [closedCase]);
    const repo = new SupabaseFollowupRepository(client as unknown as SupabaseClient);

    const persisted = await repo.persistOperationalCohortGenerations([
      { ...closedCase, operational_cohort: createCohort(2) },
    ], RUN_ID);

    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(caseId);
    expect(client.tables.get("followup_cases")).toHaveLength(1);
    expect(client.tables.get("followup_cases")![0].id).toBe(caseId);
  });

  it("I. V1 fallback and V2 hydration: existing regressions remain PASS", async () => {
    const client = new InstrumentedMemorySupabase();
    const caseId = "00000000-0000-4000-8000-000000000001";
    const testCase = makeCase(caseId, "wh-1:KHO_TON", 2);
    client.tables.set("followup_cases", [{ ...testCase }]);
    const repo = new SupabaseFollowupRepository(client as unknown as SupabaseClient);

    await repo.persistOperationalCohortGenerations([{ ...testCase }], RUN_ID);

    const updatedCase = client.tables.get("followup_cases")![0];
    expect(updatedCase.cohort_version).toBe(2);
    expect(updatedCase.member_generation_id).toBe(RUN_ID);

    // Hydrate via hydrateFollowupCaseRows
    const hydrated = await hydrateFollowupCaseRows(client as unknown as SupabaseClient, [updatedCase]);
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0].operational_cohort?.version).toBe(1);
    expect(hydrated[0].operational_cohort?.members).toHaveLength(2);
  });
});
