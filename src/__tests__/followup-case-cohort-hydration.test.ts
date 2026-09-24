import { describe, expect, it } from "vitest";
import { hydrateFollowupCaseRows } from "@/repositories/supabase/followup-case-cohort";
import { operationalCohortMemberRows, operationalCohortV2Metadata } from "@/domain/operational-learning/normalized-followup-members";
import type { OperationalCohort } from "@/domain/operational-learning/checkpoint-policy";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_RUN_ID = "33333333-3333-4333-8333-333333333333";

class MemberReadQuery {
  private generationId = "";
  private caseIds: string[] = [];
  private offset = 0;
  private end = Number.POSITIVE_INFINITY;
  constructor(private readonly rows: any[]) {}
  select(_columns: string) { return this; }
  eq(key: string, value: string) { if (key === "generation_id") this.generationId = value; return this; }
  in(key: string, values: string[]) { if (key === "followup_case_id") this.caseIds = values; return this; }
  order(_key: string, _options?: unknown) { return this; }
  range(start: number, end: number) { this.offset = start; this.end = end + 1; return this; }
  then(resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) {
    const result = this.rows.filter((row) => row.generation_id === this.generationId && this.caseIds.includes(row.followup_case_id));
    return Promise.resolve({ data: result.slice(this.offset, this.end), error: null }).then(resolve, reject);
  }
}

function cohort(count: number): OperationalCohort {
  const members = Array.from({ length: count }, (_, index) => ({
    orderCode: `ORDER-${String(index).padStart(4, "0")}`,
    customerId: "CUSTOMER-A",
    warehouseId: "WH-A",
    stage: "TRANSIT" as const,
    status: "storing",
    observedAt: "2026-09-24T03:00:00.000Z",
    readyAt: null,
    dueAt: null,
    baselineStatus: "storing",
  }));
  return { version: 1, day: "2026-09-24", capturedAt: "2026-09-24T03:00:00.000Z", baselineCodes: members.filter((_, index) => index % 2 === 0).map((item) => item.orderCode), members };
}

describe("follow-up cohort pointer hydration", () => {
  it("pages in stable order and includes only each parent's pointed generation", async () => {
    const domain = cohort(501);
    const metadata = operationalCohortV2Metadata(domain);
    const currentRows = operationalCohortMemberRows(CASE_ID, RUN_ID, RUN_ID, domain);
    const staleRows = operationalCohortMemberRows(CASE_ID, OTHER_RUN_ID, OTHER_RUN_ID, cohort(1));
    const queries: MemberReadQuery[] = [];
    const client = {
      from: (table: string) => {
        if (table !== "followup_case_members") throw new Error(`unexpected table ${table}`);
        const query = new MemberReadQuery([...currentRows, ...staleRows]);
        queries.push(query);
        return query;
      },
    };
    const [hydrated] = await hydrateFollowupCaseRows(client as any, [{
      id: CASE_ID,
      cohort_version: 2,
      member_generation_id: RUN_ID,
      operational_cohort: metadata,
    }] as any);

    expect(hydrated.operational_cohort?.members).toHaveLength(501);
    expect(hydrated.operational_cohort?.members.map((item) => item.orderCode)).toEqual(domain.members.map((item) => item.orderCode));
    expect(queries).toHaveLength(2);
  });

  it("fails closed when the pointed generation is missing or incomplete", async () => {
    const metadata = operationalCohortV2Metadata(cohort(1));
    const client = { from: () => new MemberReadQuery([]) };
    await expect(hydrateFollowupCaseRows(client as any, [{
      id: CASE_ID,
      cohort_version: 2,
      member_generation_id: RUN_ID,
      operational_cohort: metadata,
    }] as any)).rejects.toThrow("MEMBER_COUNT_MISMATCH");
  });
});
