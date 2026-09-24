import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assessOperationalCohort, type CohortMember, type OperationalCohort } from "@/domain/operational-learning/checkpoint-policy";
import {
  FOLLOWUP_COHORT_HARD_LIMIT_BYTES,
  FOLLOWUP_COHORT_NORMAL_TARGET_BYTES,
  FOLLOWUP_MEMBER_MAX_ROWS,
  FOLLOWUP_MEMBER_MAX_SERIALIZED_BYTES,
  assertFollowupMemberGenerationParity,
  hydrateOperationalCohortV2,
  operationalCohortMemberRows,
  operationalCohortV2Metadata,
  planFollowupMemberWriteChunks,
  serializedFollowupMemberBytes,
} from "@/domain/operational-learning/normalized-followup-members";
import { runFollowupCohortBackfillBatch } from "@/services/followup-cohort-backfill";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const migration = readFileSync(join(process.cwd(), "src/database/migrations/094_normalized_followup_case_members.sql"), "utf8");

function fixture(count: number, unfinished = count): OperationalCohort {
  const members: CohortMember[] = Array.from({ length: count }, (_, index) => {
    const completedAt = index < count - unfinished ? `2026-09-23T12:${String(index % 60).padStart(2, "0")}:00.000Z` : undefined;
    return {
      orderCode: `ORDER-${String(index).padStart(5, "0")}`,
      customerId: `CUSTOMER-${index % 23}`,
      warehouseId: `WAREHOUSE-${index % 7}`,
      stage: index % 4 === 0 ? "DELIVERY" : index % 4 === 1 ? "TRANSIT" : index % 4 === 2 ? "OUTBOUND" : "UNKNOWN",
      status: index % 3 === 0 ? "storing" : "transporting",
      observedAt: "2026-09-24T03:00:00.000Z",
      readyAt: index % 5 === 0 ? null : "2026-09-24T01:00:00.000Z",
      source: index % 11 === 0 ? undefined : index % 2 === 0 ? "rillnet" : "ghn_internal_order_logs",
      dueAt: index % 5 === 0 ? null : "2026-09-24T03:00:00.000Z",
      baselineStatus: index % 2 === 0 ? "storing" : "picked",
      ...(index % 2 === 0 ? { lastReminderAt: "2026-09-24T03:00:00.000Z", lastReminderStatus: "storing" } : {}),
      ...(completedAt ? { completedAt } : {}),
    };
  });
  const baselineCodes = members.filter((_, index) => index % 2 === 0).map((member) => member.orderCode);
  const failures = Object.fromEntries(members.filter((_, index) => index % 101 === 0).map((member) => [member.orderCode, "BUDGET_DEFERRED"]));
  return {
    version: 1,
    day: "2026-09-24",
    capturedAt: "2026-09-24T01:00:00.000Z",
    baselineCodes,
    members,
    lastCheckpoint: "2026-09-24:10",
    verification: { source: "ghn_internal_order_logs", checkedAt: "2026-09-24T03:01:00.000Z", snapshotAt: "2026-09-24T03:00:00.000Z", failures },
  };
}

function normalizedRoundTrip(cohort: OperationalCohort, generationId = RUN_ID) {
  const metadata = operationalCohortV2Metadata(cohort);
  const rows = operationalCohortMemberRows(CASE_ID, generationId, generationId, cohort);
  return { metadata, rows, hydrated: hydrateOperationalCohortV2(metadata, rows, { followupCaseId: CASE_ID, generationId }) };
}

describe("normalized follow-up member generations", () => {
  it.each([
    [2_874, 2_586],
    [5_000, 4_500],
    [10_000, 9_000],
  ])("round-trips and chunks %i members (%i unfinished) within both write bounds", (count, unfinished) => {
    const cohort = fixture(count, unfinished);
    const { metadata, rows, hydrated } = normalizedRoundTrip(cohort);
    const chunks = planFollowupMemberWriteChunks(rows);
    const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
    const parentJsonBytes = new TextEncoder().encode(JSON.stringify(metadata)).byteLength;

    expect(hydrated.members).toHaveLength(count);
    expect(hydrated.members.filter((member) => !member.completedAt)).toHaveLength(unfinished);
    expect(chunks.flat()).toHaveLength(count);
    expect(new Set(chunks.flat().map((row) => row.order_code)).size).toBe(count);
    expect(chunks.every((chunk) => chunk.length <= FOLLOWUP_MEMBER_MAX_ROWS)).toBe(true);
    expect(chunks.every((chunk) => serializedFollowupMemberBytes(chunk) <= FOLLOWUP_MEMBER_MAX_SERIALIZED_BYTES)).toBe(true);
    expect(metadataBytes).toBeLessThan(FOLLOWUP_COHORT_NORMAL_TARGET_BYTES);
    expect(parentJsonBytes).toBeLessThan(FOLLOWUP_COHORT_HARD_LIMIT_BYTES);
    expect(hydrated.baselineCodes).toHaveLength(cohort.baselineCodes.length);
    expect(hydrated.verification?.failures).toEqual(cohort.verification?.failures);
    expect(rows.some((row) => row.source === null)).toBe(true);
    expect(rows.every((row) => row.member_active === !row.completed_at)).toBe(true);
    expect(rows[0]).not.toHaveProperty("firstSeenAt");
    expect(rows[0]).not.toHaveProperty("eventAt");
    expect(rows[0]).not.toHaveProperty("observedWarehouseId");
  });

  it("keeps state-machine metrics, reminders, baseline, and verification equivalent after hydration", () => {
    const previous = fixture(45, 40);
    const { hydrated } = normalizedRoundTrip(previous);
    const now = Date.parse("2026-09-24T03:00:00.000Z");
    const observations = new Map(previous.members.map((member, index) => [member.orderCode, {
      orderCode: member.orderCode,
      customerId: member.customerId,
      warehouseId: member.warehouseId,
      stage: member.stage,
      status: index % 3 === 0 ? "delivering" : "storing",
      observedAt: "2026-09-24T03:00:00.000Z",
      readyAt: member.readyAt,
      source: "rillnet" as const,
    }]));
    const incoming = [...observations.values()];
    const legacy = assessOperationalCohort(previous, incoming, observations, now);
    const normalized = assessOperationalCohort(hydrated, incoming, observations, now);

    expect(normalized.due).toBe(legacy.due);
    expect(normalized.completed).toBe(legacy.completed);
    expect(normalized.progressed).toBe(legacy.progressed);
    expect(normalized.pending).toBe(legacy.pending);
    expect(normalized.unknown).toBe(legacy.unknown);
    expect(normalized.waiting).toBe(legacy.waiting);
    expect(normalized.reminderCodes).toEqual(legacy.reminderCodes);
    expect(normalized.progressPercent).toBe(legacy.progressPercent);
    expect(normalized.assessment).toBe(legacy.assessment);
    expect(normalized.cohort.members.map((member) => member.orderCode)).toEqual(legacy.cohort.members.map((member) => member.orderCode));
  });

  it("rejects missing members, foreign generations, bad baseline keys, and field drift", () => {
    const cohort = fixture(3, 3);
    const { metadata, rows } = normalizedRoundTrip(cohort);
    expect(() => hydrateOperationalCohortV2(metadata, rows.slice(1), { followupCaseId: CASE_ID, generationId: RUN_ID })).toThrow("MEMBER_COUNT_MISMATCH");
    expect(() => hydrateOperationalCohortV2(metadata, [{ ...rows[0], generation_id: "33333333-3333-4333-8333-333333333333" }, ...rows.slice(1)], { followupCaseId: CASE_ID, generationId: RUN_ID })).toThrow("CROSS_GENERATION_ROW");
    expect(() => assertFollowupMemberGenerationParity(rows, rows.slice(1))).toThrow("COUNT_MISMATCH");
    const broken = { ...cohort, baselineCodes: [...cohort.baselineCodes, "MISSING"] };
    expect(() => operationalCohortMemberRows(CASE_ID, RUN_ID, RUN_ID, broken)).toThrow("BASELINE_KEY_WITHOUT_MEMBER");
  });

  it("supports an explicit empty generation and rejects a V2 row without a pointer", async () => {
    const empty = fixture(0, 0);
    const { metadata, hydrated } = normalizedRoundTrip(empty);
    expect(metadata.memberCount).toBe(0);
    expect(hydrated.members).toEqual([]);
    const { hydrateFollowupCaseRows } = await import("@/repositories/supabase/followup-case-cohort");
    await expect(hydrateFollowupCaseRows({} as any, [{ id: CASE_ID, cohort_version: 2, member_generation_id: null, operational_cohort: metadata }] as any)).rejects.toThrow("POINTER_MISSING");
  });

  it("uses the same generation key for resumable upserts and permits a later run generation", () => {
    const cohort = fixture(4, 4);
    const first = operationalCohortMemberRows(CASE_ID, RUN_ID, RUN_ID, cohort);
    const retry = operationalCohortMemberRows(CASE_ID, RUN_ID, RUN_ID, cohort);
    const nextRunId = "44444444-4444-4444-8444-444444444444";
    const later = operationalCohortMemberRows(CASE_ID, nextRunId, nextRunId, cohort);
    expect(first.map((row) => `${row.followup_case_id}:${row.generation_id}:${row.order_code}`)).toEqual(retry.map((row) => `${row.followup_case_id}:${row.generation_id}:${row.order_code}`));
    expect(new Set([...first, ...later].map((row) => `${row.followup_case_id}:${row.generation_id}:${row.order_code}`)).size).toBe(8);
  });

  it("keeps an old parent generation authoritative after a partial write and completes the same generation on retry", () => {
    const cohort = fixture(1_250, 1_000);
    const oldGeneration = "55555555-5555-4555-8555-555555555555";
    const nextGeneration = RUN_ID;
    const rows = operationalCohortMemberRows(CASE_ID, nextGeneration, nextGeneration, cohort);
    const chunks = planFollowupMemberWriteChunks(rows);
    const table = new Map<string, (typeof rows)[number]>();
    let authoritativePointer = oldGeneration;

    for (const row of chunks[0]) table.set(`${row.followup_case_id}:${row.generation_id}:${row.order_code}`, row);
    expect(authoritativePointer).toBe(oldGeneration);

    for (const chunk of chunks) {
      for (const row of chunk) table.set(`${row.followup_case_id}:${row.generation_id}:${row.order_code}`, row);
    }
    const committedRows = [...table.values()].filter((row) => row.followup_case_id === CASE_ID && row.generation_id === nextGeneration);
    assertFollowupMemberGenerationParity(rows, committedRows);
    authoritativePointer = nextGeneration;
    expect(authoritativePointer).toBe(nextGeneration);
    expect(committedRows).toHaveLength(1_250);
  });

  it("caps the operator backfill batch at five cases", async () => {
    await expect(runFollowupCohortBackfillBatch({} as any, { limit: 6 })).rejects.toThrow("MUST_BE_1_TO_5");
  });

  it("defines only additive tables/columns and retains immutable rollback data", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS cohort_version smallint");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS member_generation_id uuid");
    expect(migration).toContain("followup_cases_cohort_generation_consistency");
    expect(migration).toContain("cohort_version = 2 AND member_generation_id IS NOT NULL");
    expect(migration).toContain("PRIMARY KEY (followup_case_id, generation_id, order_code)");
    expect(migration).toContain("REFERENCES public.followup_cases(id) ON DELETE RESTRICT");
    expect(migration).toContain("REFERENCES public.sync_runs(id) ON DELETE SET NULL");
    expect(migration).toContain("CONSTRAINT followup_case_cohort_archive_pkey PRIMARY KEY (followup_case_id)");
    expect(migration).toContain("CREATE INDEX IF NOT EXISTS idx_followup_case_member_generations_retention");
    expect(migration).toContain("PRIMARY KEY (followup_case_id, generation_id, order_code)");
    expect(migration).toContain("REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.followup_case_cohort_archive FROM service_role");
    const beforeOperatorFunction = migration.split("CREATE OR REPLACE FUNCTION public.cleanup_followup_case_member_generations")[0];
    expect(beforeOperatorFunction).not.toMatch(/^\s*(DROP|DELETE\s+FROM|TRUNCATE\s+(TABLE|public\.))/im);
    expect(migration).toContain("p_dry_run boolean DEFAULT true");
    expect(migration).toContain("interval '7 days'");
    expect(migration).toContain("FOR UPDATE OF fc SKIP LOCKED");
    expect(migration).toContain("SECURITY DEFINER\nSET search_path = pg_catalog, public");
    expect(migration).toContain("g.generation_id IS DISTINCT FROM fc.member_generation_id");
    expect(migration).toContain("cr.status IN ('PENDING', 'DISPATCHING', 'RUNNING')");
    expect(migration).toContain("sr.status = 'failed' AND ranked.created_at >= clock_timestamp() - v_grace");
    expect(migration).toContain("p_member_delete_limit > 10000");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.cleanup_followup_case_member_generations(boolean, integer, integer) FROM PUBLIC");
    expect(migration).not.toContain("GRANT EXECUTE ON FUNCTION public.cleanup_followup_case_member_generations(boolean, integer, integer) TO anon");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.cleanup_followup_case_member_generations(boolean, integer, integer) TO service_role");
  });
});
