import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import type { FollowupCaseRow } from "@/connectors/supabase/types";
import type { OperationalCohort } from "@/domain/operational-learning/checkpoint-policy";
import { SupabaseFollowupRepository } from "@/repositories/supabase/SupabaseFollowupRepository";

export const FOLLOWUP_COHORT_BACKFILL_CASE_BATCH_SIZE = 5;

export type FollowupCohortBackfillCaseResult = {
  followupCaseId: string;
  incidentKey: string;
  status: "DRY_RUN" | "BACKFILLED" | "SKIPPED" | "FAILED";
  reason?: string;
  generationId?: string;
  memberCount?: number;
};

export type FollowupCohortBackfillBatchResult = {
  applied: boolean;
  selected: number;
  backfilled: number;
  skipped: number;
  failed: number;
  nextCursor: string | null;
  cases: FollowupCohortBackfillCaseResult[];
};

type ArchivedCohort = {
  followup_case_id: string;
  original_operational_cohort: OperationalCohort;
  backfill_generation_id: string;
  source_case_updated_at: string | null;
  source_cohort_sha256: string;
};

function isV1Cohort(value: unknown): value is OperationalCohort {
  return Boolean(value && typeof value === "object" && (value as { version?: unknown }).version === 1
    && Array.isArray((value as { members?: unknown }).members)
    && Array.isArray((value as { baselineCodes?: unknown }).baselineCodes));
}

function cohortHash(cohort: OperationalCohort): string {
  return createHash("sha256").update(JSON.stringify(cohort)).digest("hex");
}

/** Process no more than five active V1 cases; dry-run is the default. */
export async function runFollowupCohortBackfillBatch(
  client: SupabaseClient,
  options: { apply?: boolean; afterId?: string | null; limit?: number } = {},
): Promise<FollowupCohortBackfillBatchResult> {
  const limit = options.limit ?? FOLLOWUP_COHORT_BACKFILL_CASE_BATCH_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > FOLLOWUP_COHORT_BACKFILL_CASE_BATCH_SIZE) {
    throw new Error(`FOLLOWUP_COHORT_BACKFILL_LIMIT_MUST_BE_1_TO_${FOLLOWUP_COHORT_BACKFILL_CASE_BATCH_SIZE}`);
  }
  let query = (client.from("followup_cases") as any)
    .select("*")
    .neq("current_state", "CLOSED")
    .is("member_generation_id", null)
    .or("cohort_version.is.null,cohort_version.eq.1")
    .not("operational_cohort", "is", null)
    .order("id", { ascending: true })
    .limit(limit);
  if (options.afterId) query = query.gt("id", options.afterId);
  const { data, error } = await query;
  if (error) throw error;
  const cases = (data || []) as FollowupCaseRow[];
  const result: FollowupCohortBackfillBatchResult = {
    applied: options.apply === true,
    selected: cases.length,
    backfilled: 0,
    skipped: 0,
    failed: 0,
    nextCursor: cases.at(-1)?.id || options.afterId || null,
    cases: [],
  };
  if (!options.apply) {
    result.cases = cases.map((followupCase) => ({
      followupCaseId: followupCase.id,
      incidentKey: followupCase.incident_key,
      status: "DRY_RUN",
      memberCount: isV1Cohort(followupCase.operational_cohort) ? followupCase.operational_cohort.members.length : undefined,
    }));
    return result;
  }

  const repository = new SupabaseFollowupRepository(client);
  for (const followupCase of cases) {
    const cohort = followupCase.operational_cohort;
    if (!isV1Cohort(cohort)) {
      result.skipped++;
      result.cases.push({ followupCaseId: followupCase.id, incidentKey: followupCase.incident_key, status: "SKIPPED", reason: "LEGACY_V1_COHORT_MISSING_OR_INVALID" });
      continue;
    }
    if (!followupCase.updated_at) {
      result.failed++;
      result.cases.push({ followupCaseId: followupCase.id, incidentKey: followupCase.incident_key, status: "FAILED", reason: "SOURCE_UPDATED_AT_MISSING" });
      continue;
    }
    const hash = cohortHash(cohort);
    const { error: archiveWriteError } = await (client.from("followup_case_cohort_archive") as any)
      .upsert({
        followup_case_id: followupCase.id,
        original_operational_cohort: cohort,
        backfill_generation_id: randomUUID(),
        source_case_updated_at: followupCase.updated_at,
        source_cohort_sha256: hash,
      }, { onConflict: "followup_case_id", ignoreDuplicates: true });
    if (archiveWriteError) {
      result.failed++;
      result.cases.push({ followupCaseId: followupCase.id, incidentKey: followupCase.incident_key, status: "FAILED", reason: `ARCHIVE_WRITE:${archiveWriteError.message}` });
      continue;
    }
    const { data: archived, error: archiveReadError } = await (client.from("followup_case_cohort_archive") as any)
      .select("followup_case_id,original_operational_cohort,backfill_generation_id,source_case_updated_at,source_cohort_sha256")
      .eq("followup_case_id", followupCase.id)
      .maybeSingle();
    if (archiveReadError || !archived) {
      result.failed++;
      result.cases.push({ followupCaseId: followupCase.id, incidentKey: followupCase.incident_key, status: "FAILED", reason: `ARCHIVE_READ:${archiveReadError?.message || "ROW_MISSING"}` });
      continue;
    }
    const stableArchive = archived as ArchivedCohort;
    if (stableArchive.source_cohort_sha256 !== hash || stableArchive.source_case_updated_at !== followupCase.updated_at) {
      result.skipped++;
      result.cases.push({ followupCaseId: followupCase.id, incidentKey: followupCase.incident_key, status: "SKIPPED", generationId: stableArchive.backfill_generation_id, reason: "ARCHIVE_SOURCE_VERSION_CHANGED;CASE_REMAINS_V1" });
      continue;
    }
    try {
      await repository.persistOperationalCohortGenerations([followupCase], stableArchive.backfill_generation_id, {
        sourceSyncRunId: null,
        archiveLegacy: false,
      });
      result.backfilled++;
      result.cases.push({ followupCaseId: followupCase.id, incidentKey: followupCase.incident_key, status: "BACKFILLED", generationId: stableArchive.backfill_generation_id, memberCount: cohort.members.length });
    } catch (backfillError) {
      result.failed++;
      result.cases.push({ followupCaseId: followupCase.id, incidentKey: followupCase.incident_key, status: "FAILED", generationId: stableArchive.backfill_generation_id, reason: backfillError instanceof Error ? backfillError.message : String(backfillError) });
    }
  }
  return result;
}
