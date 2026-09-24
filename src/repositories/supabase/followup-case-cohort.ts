import type { SupabaseClient } from "@supabase/supabase-js";
import type { OperationalCohort } from "@/domain/operational-learning/checkpoint-policy";
import {
  FOLLOWUP_MEMBER_MAX_ROWS,
  hydrateOperationalCohortV2,
  isOperationalCohortV2Metadata,
  type FollowupCaseMemberRow,
} from "@/domain/operational-learning/normalized-followup-members";

export const FOLLOWUP_MEMBER_READ_PAGE_SIZE = FOLLOWUP_MEMBER_MAX_ROWS;
export const FOLLOWUP_MEMBER_CASE_BATCH_SIZE = 100;

const MEMBER_COLUMNS = [
  "followup_case_id", "generation_id", "source_sync_run_id", "order_code", "customer_id",
  "warehouse_id", "stage", "status", "observed_at", "ready_at", "source", "baseline_status",
  "is_baseline", "due_at", "last_reminder_at", "last_reminder_status", "completed_at",
  "member_active", "verification_failure",
].join(",");

type HydratableCase = {
  id: string;
  operational_cohort?: unknown;
  cohort_version?: number | null;
  member_generation_id?: string | null;
};

function isLegacyCohort(value: unknown): value is OperationalCohort {
  return Boolean(value && typeof value === "object" && (value as { version?: unknown }).version === 1
    && Array.isArray((value as { members?: unknown }).members)
    && Array.isArray((value as { baselineCodes?: unknown }).baselineCodes));
}

async function readMemberPage(
  client: SupabaseClient,
  generationId: string,
  caseIds: string[],
  offset: number,
): Promise<FollowupCaseMemberRow[]> {
  const { data, error } = await (client.from("followup_case_members") as any)
    .select(MEMBER_COLUMNS)
    .eq("generation_id", generationId)
    .in("followup_case_id", caseIds)
    .order("followup_case_id", { ascending: true })
    .order("order_code", { ascending: true })
    .range(offset, offset + FOLLOWUP_MEMBER_READ_PAGE_SIZE - 1);
  if (error) throw error;
  return (data || []) as FollowupCaseMemberRow[];
}

/** Hydrates exactly the generation named by each parent pointer; V1 is untouched. */
export async function hydrateFollowupCaseRows<T extends HydratableCase>(
  client: SupabaseClient,
  input: T[],
): Promise<Array<T & { operational_cohort?: OperationalCohort | null }>> {
  if (!input.length) return [];
  const cases = input.map((row) => ({ ...row }));
  const v2ByGeneration = new Map<string, HydratableCase[]>();

  for (const row of cases) {
    const metadata = row.operational_cohort;
    const claimsV2 = row.cohort_version === 2 || isOperationalCohortV2Metadata(metadata);
    if (claimsV2) {
      if (row.cohort_version !== 2 || !row.member_generation_id) {
        throw new Error(`FOLLOWUP_COHORT_V2_POINTER_MISSING:${row.id}`);
      }
      if (!isOperationalCohortV2Metadata(metadata)) {
        throw new Error(`FOLLOWUP_COHORT_V2_METADATA_INVALID:${row.id}`);
      }
      const grouped = v2ByGeneration.get(row.member_generation_id) || [];
      grouped.push(row);
      v2ByGeneration.set(row.member_generation_id, grouped);
    } else if (row.cohort_version != null && row.cohort_version !== 1) {
      throw new Error(`FOLLOWUP_COHORT_VERSION_UNSUPPORTED:${row.id}:${row.cohort_version}`);
    }
  }

  for (const [generationId, generationCases] of v2ByGeneration) {
    const memberRows = new Map<string, FollowupCaseMemberRow[]>();
    const generationCaseById = new Map(generationCases.map((row) => [row.id, row]));
    for (let start = 0; start < generationCases.length; start += FOLLOWUP_MEMBER_CASE_BATCH_SIZE) {
      const caseIds = generationCases.slice(start, start + FOLLOWUP_MEMBER_CASE_BATCH_SIZE).map((row) => row.id);
      let offset = 0;
      for (;;) {
        const page = await readMemberPage(client, generationId, caseIds, offset);
        for (const member of page) {
          const parent = generationCaseById.get(member.followup_case_id);
          if (!parent || parent.member_generation_id !== member.generation_id) {
            throw new Error(`FOLLOWUP_COHORT_V2_CROSS_GENERATION_ROW:${member.followup_case_id}:${member.generation_id}`);
          }
          const rows = memberRows.get(member.followup_case_id) || [];
          rows.push(member);
          memberRows.set(member.followup_case_id, rows);
        }
        if (page.length < FOLLOWUP_MEMBER_READ_PAGE_SIZE) break;
        offset += FOLLOWUP_MEMBER_READ_PAGE_SIZE;
      }
    }
    for (const row of generationCases) {
      row.operational_cohort = hydrateOperationalCohortV2(
        row.operational_cohort as unknown as Parameters<typeof hydrateOperationalCohortV2>[0],
        memberRows.get(row.id) || [],
        { followupCaseId: row.id, generationId },
      );
    }
  }

  return cases as Array<T & { operational_cohort?: OperationalCohort | null }>;
}
