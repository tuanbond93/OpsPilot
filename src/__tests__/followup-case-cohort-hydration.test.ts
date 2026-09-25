import { describe, expect, it } from "vitest";
import { hydrateFollowupCaseRows, FOLLOWUP_MEMBER_CASE_BATCH_SIZE, FOLLOWUP_MEMBER_READ_PAGE_SIZE } from "@/repositories/supabase/followup-case-cohort";
import { operationalCohortMemberRows, operationalCohortV2Metadata } from "@/domain/operational-learning/normalized-followup-members";
import type { OperationalCohort } from "@/domain/operational-learning/checkpoint-policy";

const RUN_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_RUN_ID = "33333333-3333-4333-8333-333333333333";

class MemberReadQuery {
  private caseIds: string[] = [];
  private offset = 0;
  private end = Number.POSITIVE_INFINITY;
  readonly orderFields: string[] = [];
  constructor(private readonly rows: any[], private readonly ignoreCaseFilter = false) {}
  select(_columns: string) { return this; }
  in(key: string, values: string[]) { if (key === "followup_case_id") this.caseIds = values; return this; }
  order(key: string, _options?: unknown) { this.orderFields.push(key); return this; }
  range(start: number, end: number) { this.offset = start; this.end = end + 1; return this; }
  then(resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) {
    const result = this.rows
      .filter((row) => this.ignoreCaseFilter || this.caseIds.includes(row.followup_case_id))
      .sort((left, right) => left.followup_case_id.localeCompare(right.followup_case_id)
        || left.generation_id.localeCompare(right.generation_id)
        || left.order_code.localeCompare(right.order_code));
    return Promise.resolve({ data: result.slice(this.offset, this.end), error: null }).then(resolve, reject);
  }
}

function cohort(count: number): OperationalCohort {
  const members = Array.from({ length: count }, (_, index) => ({
    orderCode: `ORDER-${String(index).padStart(5, "0")}`,
    customerId: "CUSTOMER-A",
    warehouseId: "WH-A",
    stage: "TRANSIT" as const,
    status: "storing",
    observedAt: "2026-09-24T03:00:00.000Z",
    readyAt: null,
    dueAt: null,
    baselineStatus: "storing",
  }));
  return {
    version: 1,
    day: "2026-09-24",
    capturedAt: "2026-09-24T03:00:00.000Z",
    baselineCodes: members.filter((_, index) => index % 2 === 0).map((item) => item.orderCode),
    members,
  };
}

function caseId(index: number) {
  return `case-${String(index).padStart(4, "0")}`;
}

function v2Case(index: number, value = cohort(1), generationId = `generation-${index}`) {
  return {
    id: caseId(index),
    cohort_version: 2,
    member_generation_id: generationId,
    operational_cohort: operationalCohortV2Metadata(value),
  };
}

function clientFor(rows: any[], queries: MemberReadQuery[]) {
  return {
    from: (table: string) => {
      if (table !== "followup_case_members") throw new Error(`unexpected table ${table}`);
      const query = new MemberReadQuery(rows);
      queries.push(query);
      return query;
    },
  };
}

describe("follow-up cohort pointer hydration", () => {
  it("reads 100 unique generations in one case-batch query instead of 100 generation queries", async () => {
    const cases = Array.from({ length: 100 }, (_, index) => v2Case(index));
    const rows = cases.flatMap((row) => [
      ...operationalCohortMemberRows(row.id, row.member_generation_id!, row.member_generation_id!, cohort(1)),
      ...operationalCohortMemberRows(row.id, OTHER_RUN_ID, OTHER_RUN_ID, cohort(1)),
    ]);
    const queries: MemberReadQuery[] = [];

    const hydrated = await hydrateFollowupCaseRows(clientFor(rows, queries) as any, cases as any);

    expect(queries).toHaveLength(1);
    expect(queries[0].orderFields).toEqual(["followup_case_id", "generation_id", "order_code"]);
    expect(hydrated).toHaveLength(100);
    expect(hydrated.every((row) => row.operational_cohort?.members.length === 1)).toBe(true);
  });

  it("hydrates exact parent pointers, ignores retained generations, and pages deterministically", async () => {
    const domain = cohort(501);
    const row = v2Case(1, domain, RUN_ID);
    const currentRows = operationalCohortMemberRows(row.id, RUN_ID, RUN_ID, domain);
    const staleRows = operationalCohortMemberRows(row.id, OTHER_RUN_ID, OTHER_RUN_ID, cohort(1));
    const queries: MemberReadQuery[] = [];

    const [hydrated] = await hydrateFollowupCaseRows(clientFor([...currentRows, ...staleRows], queries) as any, [row] as any);

    expect(hydrated.operational_cohort?.members).toHaveLength(501);
    expect(hydrated.operational_cohort?.members.map((item) => item.orderCode)).toEqual(domain.members.map((item) => item.orderCode));
    expect(queries).toHaveLength(2);
    expect(FOLLOWUP_MEMBER_READ_PAGE_SIZE).toBe(500);
  });

  it("fails closed when the pointed generation is missing or incomplete", async () => {
    const row = v2Case(1);
    await expect(hydrateFollowupCaseRows(clientFor([], []) as any, [row] as any)).rejects.toThrow("MEMBER_COUNT_MISMATCH");
  });

  it("fails closed if a page contains a row for a case outside the requested case batch", async () => {
    const row = v2Case(1);
    const foreign = operationalCohortMemberRows("foreign-case", row.member_generation_id!, row.member_generation_id!, cohort(1));
    const query = new MemberReadQuery(foreign, true);
    const client = { from: () => query };

    await expect(hydrateFollowupCaseRows(client as any, [row] as any)).rejects.toThrow("FOLLOWUP_COHORT_V2_CROSS_CASE_ROW");
  });

  it.each([null, 1])("keeps a null-cohort V1 row readable when cohort_version is %s", async (cohortVersion) => {
    const source = {
      id: caseId(1),
      cohort_version: cohortVersion,
      member_generation_id: null,
      operational_cohort: null,
    };
    let memberReads = 0;
    const client = { from: () => { memberReads++; throw new Error("V1 null-cohort rows must not read normalized members"); } };

    const [hydrated] = await hydrateFollowupCaseRows(client as any, [source] as any);

    expect(hydrated).toMatchObject(source);
    expect(hydrated.operational_cohort).toBeNull();
    expect(memberReads).toBe(0);
  });

  it("hydrates mixed V1 and V2 batches while leaving the V1 cohort untouched", async () => {
    const v1 = { id: caseId(1), cohort_version: 1, member_generation_id: null, operational_cohort: cohort(1) };
    const v2 = v2Case(2, cohort(2), RUN_ID);
    const rows = operationalCohortMemberRows(v2.id, RUN_ID, RUN_ID, cohort(2));
    const queries: MemberReadQuery[] = [];

    const hydrated = await hydrateFollowupCaseRows(clientFor(rows, queries) as any, [v1, v2] as any);

    expect(queries).toHaveLength(1);
    expect(hydrated[0].operational_cohort).toEqual(v1.operational_cohort);
    expect(hydrated[1].operational_cohort?.members).toHaveLength(2);
  });

  it("pages a 2,874-member case without relying on a single PostgREST result page", async () => {
    const domain = cohort(2_874);
    const row = v2Case(1, domain, RUN_ID);
    const rows = operationalCohortMemberRows(row.id, RUN_ID, RUN_ID, domain);
    const queries: MemberReadQuery[] = [];

    const [hydrated] = await hydrateFollowupCaseRows(clientFor(rows, queries) as any, [row] as any);

    expect(queries).toHaveLength(Math.ceil(2_874 / FOLLOWUP_MEMBER_READ_PAGE_SIZE));
    expect(hydrated.operational_cohort?.members.map((item) => item.orderCode)).toEqual(domain.members.map((item) => item.orderCode));
  });

  it("hydrates the 1,011-case backfill shape in bounded case batches and pages", async () => {
    const cases = Array.from({ length: 1_011 }, (_, index) => v2Case(index, cohort(index < 62 ? 52 : 51), `generation-${index}`));
    const rows = cases.flatMap((row, index) => operationalCohortMemberRows(
      row.id,
      row.member_generation_id!,
      row.member_generation_id!,
      cohort(index < 62 ? 52 : 51),
    ));
    const queries: MemberReadQuery[] = [];

    const hydrated = await hydrateFollowupCaseRows(clientFor(rows, queries) as any, cases as any);

    expect(hydrated).toHaveLength(1_011);
    expect(hydrated.reduce((total, row) => total + (row.operational_cohort?.members.length || 0), 0)).toBe(51_623);
    expect(queries).toHaveLength(112);
    expect(queries.length).toBeLessThan(1_011 / 8);
    expect(FOLLOWUP_MEMBER_CASE_BATCH_SIZE).toBeLessThanOrEqual(100);
  });
});
