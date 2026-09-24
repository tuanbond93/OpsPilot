import type { CohortMember, OperationalCohort } from "./checkpoint-policy";

export const FOLLOWUP_MEMBER_MAX_ROWS = 500;
export const FOLLOWUP_MEMBER_MAX_SERIALIZED_BYTES = 131_072;
export const FOLLOWUP_COHORT_NORMAL_TARGET_BYTES = 32_768;
export const FOLLOWUP_COHORT_HARD_LIMIT_BYTES = 131_072;

export type FollowupCaseMemberRow = {
  followup_case_id: string;
  generation_id: string;
  source_sync_run_id: string | null;
  order_code: string;
  customer_id: string;
  warehouse_id: string;
  stage: CohortMember["stage"];
  status: string;
  observed_at: string;
  ready_at: string | null;
  source: CohortMember["source"] | null;
  baseline_status: string;
  is_baseline: boolean;
  due_at: string | null;
  last_reminder_at: string | null;
  last_reminder_status: string | null;
  completed_at: string | null;
  member_active: boolean;
  verification_failure: string | null;
};

export type OperationalCohortV2Metadata = {
  version: 2;
  day: string;
  capturedAt: string;
  lastCheckpoint?: string;
  memberStore: "followup_case_members";
  memberCount: number;
  baselineCount: number;
  verification?: {
    source: "ghn_internal_order_logs";
    checkedAt: string;
    snapshotAt?: string;
    failureCount: number;
  };
};

export function isOperationalCohortV2Metadata(value: unknown): value is OperationalCohortV2Metadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Record<string, unknown>;
  return metadata.version === 2
    && metadata.memberStore === "followup_case_members"
    && typeof metadata.day === "string"
    && typeof metadata.capturedAt === "string"
    && Number.isSafeInteger(metadata.memberCount) && Number(metadata.memberCount) >= 0
    && Number.isSafeInteger(metadata.baselineCount) && Number(metadata.baselineCount) >= 0
    && (!metadata.verification || typeof metadata.verification === "object");
}

export function operationalCohortV2Metadata(cohort: OperationalCohort): OperationalCohortV2Metadata {
  const metadata: OperationalCohortV2Metadata = {
    version: 2,
    day: cohort.day,
    capturedAt: cohort.capturedAt,
    memberStore: "followup_case_members",
    memberCount: cohort.members.length,
    baselineCount: cohort.members.reduce((count, member) => count + (cohort.baselineCodes.includes(member.orderCode) ? 1 : 0), 0),
  };
  if (cohort.lastCheckpoint) metadata.lastCheckpoint = cohort.lastCheckpoint;
  if (cohort.verification) {
    metadata.verification = {
      source: cohort.verification.source,
      checkedAt: cohort.verification.checkedAt,
      ...(cohort.verification.snapshotAt ? { snapshotAt: cohort.verification.snapshotAt } : {}),
      failureCount: Object.keys(cohort.verification.failures || {}).length,
    };
  }
  return metadata;
}

export function operationalCohortMemberRows(
  followupCaseId: string,
  generationId: string,
  sourceSyncRunId: string | null,
  cohort: OperationalCohort,
): FollowupCaseMemberRow[] {
  const memberCodes = new Set(cohort.members.map((member) => member.orderCode));
  if (memberCodes.size !== cohort.members.length) throw new Error("FOLLOWUP_COHORT_V1_DUPLICATE_ORDER_CODE");
  if (cohort.baselineCodes.some((orderCode) => !memberCodes.has(orderCode))) {
    throw new Error("FOLLOWUP_COHORT_V1_BASELINE_KEY_WITHOUT_MEMBER");
  }
  if (Object.keys(cohort.verification?.failures || {}).some((orderCode) => !memberCodes.has(orderCode))) {
    throw new Error("FOLLOWUP_COHORT_V1_VERIFICATION_KEY_WITHOUT_MEMBER");
  }
  const baselineCodes = new Set(cohort.baselineCodes);
  return cohort.members.map((member) => ({
    followup_case_id: followupCaseId,
    generation_id: generationId,
    source_sync_run_id: sourceSyncRunId,
    order_code: member.orderCode,
    customer_id: member.customerId,
    warehouse_id: member.warehouseId,
    stage: member.stage,
    status: member.status,
    observed_at: member.observedAt,
    ready_at: member.readyAt,
    source: member.source || null,
    baseline_status: member.baselineStatus,
    is_baseline: baselineCodes.has(member.orderCode),
    due_at: member.dueAt,
    last_reminder_at: member.lastReminderAt || null,
    last_reminder_status: member.lastReminderStatus || null,
    completed_at: member.completedAt || null,
    member_active: !member.completedAt,
    verification_failure: cohort.verification?.failures?.[member.orderCode] || null,
  }));
}

export function hydrateOperationalCohortV2(
  metadata: OperationalCohortV2Metadata,
  rows: FollowupCaseMemberRow[],
  identity?: { followupCaseId: string; generationId: string },
): OperationalCohort {
  if (!isOperationalCohortV2Metadata(metadata)) {
    throw new Error("FOLLOWUP_COHORT_V2_METADATA_INVALID");
  }
  if (rows.length !== metadata.memberCount) {
    throw new Error(`FOLLOWUP_COHORT_V2_MEMBER_COUNT_MISMATCH:expected=${metadata.memberCount}:actual=${rows.length}`);
  }
  if (identity && rows.some((row) => row.followup_case_id !== identity.followupCaseId || row.generation_id !== identity.generationId)) {
    throw new Error("FOLLOWUP_COHORT_V2_CROSS_GENERATION_ROW");
  }
  const seen = new Set<string>();
  const failures: Record<string, string> = {};
  const members: CohortMember[] = [...rows]
    .sort((left, right) => left.order_code.localeCompare(right.order_code))
    .map((row) => {
      if (!row.order_code || seen.has(row.order_code)) {
        throw new Error(`FOLLOWUP_COHORT_V2_MEMBER_KEY_INVALID:${row.order_code || "empty"}`);
      }
      seen.add(row.order_code);
      if (row.verification_failure) failures[row.order_code] = row.verification_failure;
      return {
        orderCode: row.order_code,
        customerId: row.customer_id,
        warehouseId: row.warehouse_id,
        stage: row.stage,
        status: row.status,
        observedAt: row.observed_at,
        readyAt: row.ready_at,
        ...(row.source ? { source: row.source } : {}),
        baselineStatus: row.baseline_status,
        dueAt: row.due_at,
        ...(row.last_reminder_at ? { lastReminderAt: row.last_reminder_at } : {}),
        ...(row.last_reminder_status ? { lastReminderStatus: row.last_reminder_status } : {}),
        ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      };
    });
  const baselineCodes = rows.filter((row) => row.is_baseline).map((row) => row.order_code).sort((a, b) => a.localeCompare(b));
  if (baselineCodes.length !== metadata.baselineCount) {
    throw new Error(`FOLLOWUP_COHORT_V2_BASELINE_COUNT_MISMATCH:expected=${metadata.baselineCount}:actual=${baselineCodes.length}`);
  }
  const verification = metadata.verification ? {
    source: metadata.verification.source,
    checkedAt: metadata.verification.checkedAt,
    ...(metadata.verification.snapshotAt ? { snapshotAt: metadata.verification.snapshotAt } : {}),
    failures,
  } : undefined;
  if (metadata.verification && Object.keys(failures).length !== metadata.verification.failureCount) {
    throw new Error(`FOLLOWUP_COHORT_V2_VERIFICATION_COUNT_MISMATCH:expected=${metadata.verification.failureCount}:actual=${Object.keys(failures).length}`);
  }
  return {
    version: 1,
    day: metadata.day,
    capturedAt: metadata.capturedAt,
    baselineCodes,
    members,
    ...(metadata.lastCheckpoint ? { lastCheckpoint: metadata.lastCheckpoint } : {}),
    ...(verification ? { verification } : {}),
  };
}

export function serializedFollowupMemberBytes(rows: FollowupCaseMemberRow[]): number {
  return new TextEncoder().encode(JSON.stringify(rows)).byteLength;
}

export function planFollowupMemberWriteChunks(
  rows: FollowupCaseMemberRow[],
  maxRows = FOLLOWUP_MEMBER_MAX_ROWS,
  maxBytes = FOLLOWUP_MEMBER_MAX_SERIALIZED_BYTES,
): FollowupCaseMemberRow[][] {
  if (!Number.isInteger(maxRows) || maxRows < 1 || !Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("FOLLOWUP_MEMBER_CHUNK_LIMIT_INVALID");
  }
  const chunks: FollowupCaseMemberRow[][] = [];
  let current: FollowupCaseMemberRow[] = [];
  for (const row of rows) {
    const next = [...current, row];
    if (current.length && (next.length > maxRows || serializedFollowupMemberBytes(next) > maxBytes)) {
      chunks.push(current);
      current = [row];
    } else {
      current = next;
    }
    if (serializedFollowupMemberBytes(current) > maxBytes) {
      throw new Error(`FOLLOWUP_MEMBER_ROW_EXCEEDS_MAX_PAYLOAD_BYTES:${row.order_code}`);
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function comparableTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`FOLLOWUP_MEMBER_TIMESTAMP_INVALID:${value}`);
  return timestamp;
}

export function assertFollowupMemberGenerationParity(
  expected: FollowupCaseMemberRow[],
  actual: FollowupCaseMemberRow[],
): void {
  if (actual.length !== expected.length) {
    throw new Error(`FOLLOWUP_MEMBER_GENERATION_COUNT_MISMATCH:expected=${expected.length}:actual=${actual.length}`);
  }
  const expectedByCode = new Map(expected.map((row) => [row.order_code, row]));
  const actualByCode = new Map(actual.map((row) => [row.order_code, row]));
  if (expectedByCode.size !== expected.length || actualByCode.size !== actual.length) {
    throw new Error("FOLLOWUP_MEMBER_GENERATION_DUPLICATE_ORDER_CODE");
  }
  if (expectedByCode.size !== actualByCode.size || [...expectedByCode.keys()].some((key) => !actualByCode.has(key))) {
    throw new Error("FOLLOWUP_MEMBER_GENERATION_ORDER_CODE_SET_MISMATCH");
  }
  for (const [code, expectedRow] of expectedByCode) {
    const actualRow = actualByCode.get(code)!;
    const textFields: Array<keyof FollowupCaseMemberRow> = [
      "followup_case_id", "generation_id", "source_sync_run_id", "order_code", "customer_id",
      "warehouse_id", "stage", "status", "source", "baseline_status", "is_baseline",
      "last_reminder_status", "member_active", "verification_failure",
    ];
    for (const field of textFields) {
      if (actualRow[field] !== expectedRow[field]) {
        throw new Error(`FOLLOWUP_MEMBER_GENERATION_FIELD_MISMATCH:${code}:${field}`);
      }
    }
    const timestampFields: Array<keyof FollowupCaseMemberRow> = [
      "observed_at", "ready_at", "due_at", "last_reminder_at", "completed_at",
    ];
    for (const field of timestampFields) {
      if (comparableTimestamp(actualRow[field] as string | null) !== comparableTimestamp(expectedRow[field] as string | null)) {
        throw new Error(`FOLLOWUP_MEMBER_GENERATION_FIELD_MISMATCH:${code}:${field}`);
      }
    }
  }
}
