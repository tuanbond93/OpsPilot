import { serializedPayloadBytes } from "@/observability/runtimeDiagnostics";
import type { FollowupCaseUpsert } from "@/repositories/interfaces/IFollowupRepository";

export const FOLLOWUP_CASE_UPSERT_MAX_ROWS = 10;
export const FOLLOWUP_CASE_UPSERT_MAX_PAYLOAD_BYTES = 256 * 1024;

// SupabaseFollowupRepository adds one ISO timestamp to every row. This sample
// has the same byte length as Date#toISOString(), so chunk sizing matches the
// serialized PostgREST payload without depending on the current clock.
const UPDATED_AT_SAMPLE = "2000-01-01T00:00:00.000Z";

export function followupCaseUpsertPayloadBytes(cases: FollowupCaseUpsert[]): number {
  return serializedPayloadBytes(cases.map((caseData) => ({
    ...caseData,
    updated_at: UPDATED_AT_SAMPLE,
  })));
}

export function planFollowupCaseUpsertChunks(cases: FollowupCaseUpsert[]): FollowupCaseUpsert[][] {
  const chunks: FollowupCaseUpsert[][] = [];
  let current: FollowupCaseUpsert[] = [];

  for (const caseData of cases) {
    const singleRowBytes = followupCaseUpsertPayloadBytes([caseData]);
    if (singleRowBytes > FOLLOWUP_CASE_UPSERT_MAX_PAYLOAD_BYTES) {
      throw new Error("FOLLOWUP_CASE_UPSERT_ROW_EXCEEDS_MAX_PAYLOAD_BYTES");
    }

    const candidate = [...current, caseData];
    if (current.length > 0 && (
      candidate.length > FOLLOWUP_CASE_UPSERT_MAX_ROWS
      || followupCaseUpsertPayloadBytes(candidate) > FOLLOWUP_CASE_UPSERT_MAX_PAYLOAD_BYTES
    )) {
      chunks.push(current);
      current = [caseData];
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}
