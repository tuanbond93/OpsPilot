import type { SupabaseClient } from "@supabase/supabase-js";
import type { FollowupCaseRow } from "@/connectors/supabase/types";
import type { CohortMember, OperationalCohort } from "@/domain/operational-learning/checkpoint-policy";
import { hydrateFollowupCaseRows } from "@/repositories/supabase/followup-case-cohort";

export const FOLLOWUP_COHORT_ROLLBACK_CASE_BATCH_SIZE = 5;

type ArchiveRow = {
  followup_case_id: string;
  original_operational_cohort: OperationalCohort;
};

export type FollowupCohortRollbackCaseResult = {
  followupCaseId: string;
  incidentKey: string;
  status: "DRY_RUN" | "ROLLED_BACK" | "SKIPPED" | "FAILED";
  memberCount?: number;
  reason?: string;
};

export type FollowupCohortRollbackBatchResult = {
  applied: boolean;
  selected: number;
  rolledBack: number;
  skipped: number;
  failed: number;
  nextCursor: string | null;
  cases: FollowupCohortRollbackCaseResult[];
};

/** Restores optional V1-only member properties from the immutable cutover archive. */
export function restoreLegacyOnlyMemberFields(
  current: OperationalCohort,
  archived: OperationalCohort,
): OperationalCohort {
  const archivedByCode = new Map(archived.members.map((member) => [member.orderCode, member]));
  return {
    ...current,
    members: current.members.map((member): CohortMember => {
      const old = archivedByCode.get(member.orderCode);
      if (!old) return member;
      return {
        ...member,
        ...(old.firstSeenAt ? { firstSeenAt: old.firstSeenAt } : {}),
        ...(old.eventAt ? { eventAt: old.eventAt } : {}),
        ...(old.observedWarehouseId ? { observedWarehouseId: old.observedWarehouseId } : {}),
      };
    }),
  };
}

export function assertRollbackCohortParity(expected: OperationalCohort, actual: OperationalCohort): void {
  const expectedCodes = [...expected.members.map((member) => member.orderCode)].sort();
  const actualCodes = [...actual.members.map((member) => member.orderCode)].sort();
  if (expectedCodes.length !== actualCodes.length
    || expectedCodes.some((code, index) => code !== actualCodes[index])) {
    throw new Error("FOLLOWUP_COHORT_ROLLBACK_ORDER_CODE_SET_MISMATCH");
  }
  if (JSON.stringify([...expected.baselineCodes].sort()) !== JSON.stringify([...actual.baselineCodes].sort())) {
    throw new Error("FOLLOWUP_COHORT_ROLLBACK_BASELINE_MISMATCH");
  }
  const expectedFailures = expected.verification?.failures || {};
  const actualFailures = actual.verification?.failures || {};
  if (JSON.stringify(Object.entries(expectedFailures).sort()) !== JSON.stringify(Object.entries(actualFailures).sort())) {
    throw new Error("FOLLOWUP_COHORT_ROLLBACK_VERIFICATION_MISMATCH");
  }
  if (expected.verification?.source !== actual.verification?.source
    || expected.verification?.checkedAt !== actual.verification?.checkedAt
    || expected.verification?.snapshotAt !== actual.verification?.snapshotAt) {
    throw new Error("FOLLOWUP_COHORT_ROLLBACK_VERIFICATION_SUMMARY_MISMATCH");
  }
  const actualByCode = new Map(actual.members.map((member) => [member.orderCode, member]));
  for (const member of expected.members) {
    const restored = actualByCode.get(member.orderCode);
    if (!restored
      || restored.customerId !== member.customerId
      || restored.warehouseId !== member.warehouseId
      || restored.stage !== member.stage
      || restored.status !== member.status
      || restored.observedAt !== member.observedAt
      || restored.readyAt !== member.readyAt
      || restored.source !== member.source
      || restored.dueAt !== member.dueAt
      || restored.baselineStatus !== member.baselineStatus
      || restored.lastReminderAt !== member.lastReminderAt
      || restored.lastReminderStatus !== member.lastReminderStatus
      || restored.completedAt !== member.completedAt) {
      throw new Error(`FOLLOWUP_COHORT_ROLLBACK_MEMBER_FIELD_MISMATCH:${member.orderCode}`);
    }
  }
}

function isV2Case(row: FollowupCaseRow): boolean {
  return row.cohort_version === 2 && Boolean(row.member_generation_id);
}

/** Dry-run by default. Each apply batch is limited to five case pointer flips. */
export async function runFollowupCohortRollbackBatch(
  client: SupabaseClient,
  options: { apply?: boolean; afterId?: string | null; limit?: number } = {},
): Promise<FollowupCohortRollbackBatchResult> {
  const limit = options.limit ?? FOLLOWUP_COHORT_ROLLBACK_CASE_BATCH_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > FOLLOWUP_COHORT_ROLLBACK_CASE_BATCH_SIZE) {
    throw new Error(`FOLLOWUP_COHORT_ROLLBACK_LIMIT_MUST_BE_1_TO_${FOLLOWUP_COHORT_ROLLBACK_CASE_BATCH_SIZE}`);
  }
  let query = (client.from("followup_cases") as any)
    .select("id,incident_key,updated_at,operational_cohort,cohort_version,member_generation_id")
    .eq("cohort_version", 2)
    .not("member_generation_id", "is", null)
    .order("id", { ascending: true })
    .limit(limit);
  if (options.afterId) query = query.gt("id", options.afterId);
  const { data, error } = await query;
  if (error) throw error;
  const selected = (data || []) as FollowupCaseRow[];
  const result: FollowupCohortRollbackBatchResult = {
    applied: options.apply === true,
    selected: selected.length,
    rolledBack: 0,
    skipped: 0,
    failed: 0,
    nextCursor: selected.at(-1)?.id || options.afterId || null,
    cases: [],
  };
  if (!selected.length) return result;

  const archiveQuery = (client.from("followup_case_cohort_archive") as any)
    .select("followup_case_id,original_operational_cohort")
    .in("followup_case_id", selected.map((row) => row.id));
  const { data: archives, error: archiveError } = await archiveQuery;
  if (archiveError) throw archiveError;
  const archiveByCase = new Map<string, ArchiveRow>((archives || []).map((row: ArchiveRow) => [row.followup_case_id, row]));

  let hydrated: Array<FollowupCaseRow & { operational_cohort?: OperationalCohort | null }>;
  try {
    hydrated = await hydrateFollowupCaseRows(client, selected);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    result.failed += selected.length;
    result.cases = selected.map((row) => ({ followupCaseId: row.id, incidentKey: row.incident_key, status: "FAILED", reason }));
    return result;
  }

  for (const row of hydrated) {
    if (!isV2Case(row) || !row.updated_at || !row.operational_cohort) {
      result.skipped++;
      result.cases.push({ followupCaseId: row.id, incidentKey: row.incident_key, status: "SKIPPED", reason: "V2_POINTER_OR_SOURCE_COHORT_MISSING" });
      continue;
    }
    const archive = archiveByCase.get(row.id);
    if (!archive?.original_operational_cohort) {
      result.failed++;
      result.cases.push({ followupCaseId: row.id, incidentKey: row.incident_key, status: "FAILED", reason: "IMMUTABLE_LEGACY_ARCHIVE_MISSING" });
      continue;
    }

    try {
      const reconstructed = restoreLegacyOnlyMemberFields(row.operational_cohort, archive.original_operational_cohort);
      assertRollbackCohortParity(row.operational_cohort, reconstructed);
      if (!options.apply) {
        result.cases.push({ followupCaseId: row.id, incidentKey: row.incident_key, status: "DRY_RUN", memberCount: reconstructed.members.length });
        continue;
      }

      const { data: updated, error: updateError } = await (client.from("followup_cases") as any)
        .update({
          operational_cohort: reconstructed,
          cohort_version: 1,
          member_generation_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("cohort_version", 2)
        .eq("member_generation_id", row.member_generation_id)
        .eq("updated_at", row.updated_at)
        .select("id")
        .maybeSingle();
      if (updateError) throw updateError;
      if (!updated) throw new Error("PARENT_POINTER_CHANGED_DURING_ROLLBACK");

      const { data: verified, error: verifyError } = await (client.from("followup_cases") as any)
        .select("operational_cohort,cohort_version,member_generation_id")
        .eq("id", row.id)
        .maybeSingle();
      if (verifyError) throw verifyError;
      if (!verified || verified.cohort_version !== 1 || verified.member_generation_id !== null) {
        throw new Error("ROLLBACK_PARENT_POINTER_VERIFICATION_FAILED");
      }
      assertRollbackCohortParity(reconstructed, verified.operational_cohort as OperationalCohort);
      result.rolledBack++;
      result.cases.push({ followupCaseId: row.id, incidentKey: row.incident_key, status: "ROLLED_BACK", memberCount: reconstructed.members.length });
    } catch (error) {
      result.failed++;
      result.cases.push({
        followupCaseId: row.id,
        incidentKey: row.incident_key,
        status: "FAILED",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
