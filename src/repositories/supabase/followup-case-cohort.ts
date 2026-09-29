import type { SupabaseClient } from "@supabase/supabase-js";
import { traceV1Call } from "@/observability/v1-attempt-telemetry";
import { traceV1GapSync, v1GapSerializedBytes } from "@/observability/v1-gap-telemetry";
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
  caseIds: string[],
  offset: number,
): Promise<FollowupCaseMemberRow[]> {
  const { data, error } = await traceV1Call("case_member_hydration_read", "followup_case_members", null, undefined, () => (client.from("followup_case_members") as any)
    .select(MEMBER_COLUMNS)
    .in("followup_case_id", caseIds)
    .order("followup_case_id", { ascending: true })
    .order("generation_id", { ascending: true })
    .order("order_code", { ascending: true })
    .range(offset, offset + FOLLOWUP_MEMBER_READ_PAGE_SIZE - 1));
  if (error) throw error;
  return (data || []) as FollowupCaseMemberRow[];
}

/** Hydrates exactly the generation named by each parent pointer; V1 is untouched. */
export async function hydrateFollowupCaseRows<T extends HydratableCase>(
  client: SupabaseClient,
  input: T[],
): Promise<Array<T & { operational_cohort?: OperationalCohort | null }>> {
  if (!input.length) return [];
  const cases = traceV1GapSync(
    "case_row_clone",
    { input_rows: input.length, input_bytes: v1GapSerializedBytes(input) },
    () => input.map((row) => ({ ...row })),
    (value) => ({ output_rows: value.length, output_bytes: v1GapSerializedBytes(value) }),
  );
  const v2Cases: HydratableCase[] = [];

  traceV1GapSync(
    "case_v2_partition_and_validation",
    { input_rows: cases.length, input_bytes: v1GapSerializedBytes(cases) },
    () => {
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
          v2Cases.push(row);
        } else if (row.cohort_version != null && row.cohort_version !== 1) {
          throw new Error(`FOLLOWUP_COHORT_VERSION_UNSUPPORTED:${row.id}:${row.cohort_version}`);
        }
      }
      return v2Cases.length;
    },
    (value) => ({ output_rows: value, output_bytes: v1GapSerializedBytes(v2Cases) }),
  );

  for (let start = 0; start < v2Cases.length; start += FOLLOWUP_MEMBER_CASE_BATCH_SIZE) {
    const caseBatch = v2Cases.slice(start, start + FOLLOWUP_MEMBER_CASE_BATCH_SIZE);
    const caseById = new Map(caseBatch.map((row) => [row.id, row]));
    const memberRows = new Map<string, FollowupCaseMemberRow[]>();
    let offset = 0;
    for (;;) {
      const page = await readMemberPage(client, [...caseById.keys()], offset);
      traceV1GapSync(
        "member_rows_grouping",
        { input_rows: page.length, input_bytes: v1GapSerializedBytes(page) },
        () => {
          for (const member of page) {
            const parent = caseById.get(member.followup_case_id);
            if (!parent) {
              throw new Error(`FOLLOWUP_COHORT_V2_CROSS_CASE_ROW:${member.followup_case_id}`);
            }
            // Retained generations are expected during the rollback window. Only
            // rows for the exact parent pointer participate in hydration.
            if (parent.member_generation_id !== member.generation_id) continue;
            const rows = memberRows.get(member.followup_case_id) || [];
            rows.push(member);
            memberRows.set(member.followup_case_id, rows);
          }
        },
        () => ({ output_rows: [...memberRows.values()].reduce((sum, rows) => sum + rows.length, 0), output_bytes: v1GapSerializedBytes([...memberRows.values()]) }),
      );
      if (page.length < FOLLOWUP_MEMBER_READ_PAGE_SIZE) break;
      offset += FOLLOWUP_MEMBER_READ_PAGE_SIZE;
    }

    for (const row of caseBatch) {
      const generationId = row.member_generation_id!;
      const rows = memberRows.get(row.id) || [];
      row.operational_cohort = traceV1GapSync(
        "cohort_materialization",
        { input_rows: rows.length, input_bytes: v1GapSerializedBytes(rows) },
        () => hydrateOperationalCohortV2(
          row.operational_cohort as unknown as Parameters<typeof hydrateOperationalCohortV2>[0],
          rows,
          { followupCaseId: row.id, generationId },
        ),
        (value) => ({ output_rows: value.members.length, output_bytes: v1GapSerializedBytes(value) }),
      );
    }
  }

  return traceV1GapSync(
    "hydration_return",
    { input_rows: cases.length, input_bytes: v1GapSerializedBytes(cases) },
    () => cases as Array<T & { operational_cohort?: OperationalCohort | null }>,
    (value) => ({ output_rows: value.length, output_bytes: v1GapSerializedBytes(value) }),
  );
}
