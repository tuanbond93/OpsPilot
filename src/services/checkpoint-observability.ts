import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/connectors/supabase";
import { checkpointKey } from "@/domain/operational-learning/checkpoint-policy";

export type EvidenceReadStatus =
  | "FOUND"
  | "NOT_FOUND"
  | "UNKNOWN"
  | "NOT_APPLICABLE"
  | "NOT_IMPLEMENTED_IN_CURRENT_ARCHITECTURE";

type QueryResult<T> =
  | { ok: true; data: T; count: number | null; notApplicable?: false }
  | { ok: true; data: T; count: null; notApplicable: true }
  | { ok: false; errorCode: string };

type NamedQuery = { source: string; result: QueryResult<unknown> };

const SYNC_PHASES = [
  "FETCHING_SNAPSHOT",
  "PERSISTING_SNAPSHOTS",
  "PERSISTING_INCIDENTS",
  "PERSISTING_HISTORY",
  "PROCESSING_FOLLOWUPS",
  "ENQUEUE_NOTIFICATIONS",
  "ENQUEUE_AI",
  "REFRESHING_PROJECTIONS",
  "COMPLETED",
] as const;

const SYNC_RUN_FIELDS =
  "id,checkpoint_at,status,current_phase,completed_phases,started_at,completed_at,duration_ms,error_code,error_message,fetched_order_count";

const AUDIT_FIELDS =
  "id,sync_run_id,checkpoint_at,started_at,completed_at,execution_status,http_status,supported_cases_evaluated,kho_ton_evaluated,kho_chua_luan_chuyen_evaluated,first_push_pending_created,second_push_pending_created,third_push_pending_created,escalation_pending_created,total_dispatch_eligible_pending,telegram_scanned,recipients_resolved,interactions_created,send_attempts,send_success,send_failed,status_updates_active,status_updates_resolved,status_update_batches_sent,status_update_batches_failed,exclusion_counts,error_code,error_message_safe,created_at";

const MANIFEST_FIELDS =
  "source_system,population_status,expected_observation_count,persisted_observation_count,duplicate_identical_count,duplicate_conflict_count,population_completed_at";

const DELIVERY_FIELDS = "id,status,sent_at,telegram_message_id,updated_at";

function safeErrorCode(value: unknown): string {
  const candidate =
    value && typeof value === "object" && "code" in value
      ? String((value as { code?: unknown }).code ?? "")
      : "";
  return /^[A-Za-z0-9][A-Za-z0-9_:-]{0,39}$/.test(candidate)
    ? candidate
    : "OBSERVABILITY_SOURCE_QUERY_FAILED";
}

/**
 * Free-form errors can include upstream payloads. Keep operator-useful codes,
 * but remove common credentials, contact details, parcel IDs, and UUIDs.
 */
export function redactDiagnosticMessage(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let message = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  message = message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_TOKEN]")
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&\s]*/gi, "$1[REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^,;\s]+/gi, "$1=[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/(?<!\w)(?:\+?84|0)(?:3|5|7|8|9)\d{8}(?!\w)/g, "[REDACTED_PHONE]")
    .replace(/\b\d{8,}\b/g, "[REDACTED_ID]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[REDACTED_ID]")
    .replace(/\b(customer|recipient|phone|email|address|parcel|order(?:_code)?)\s*[:=]\s*[^,;}\]]+/gi, "$1=[REDACTED]");
  return message.slice(0, 500);
}

function readResult<T>(query: PromiseLike<any>): Promise<QueryResult<T>> {
  return Promise.resolve(query)
    .then(({ data, error, count }) => {
      if (error) return { ok: false as const, errorCode: safeErrorCode(error) };
      return {
        ok: true as const,
        data: data as T,
        count: typeof count === "number" ? count : null,
      };
    })
    .catch((error) => ({ ok: false as const, errorCode: safeErrorCode(error) }));
}

function notApplicable<T>(): QueryResult<T> {
  return { ok: true, data: null as T, count: null, notApplicable: true };
}

function objectValue(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

function rowsValue(value: unknown): Array<Record<string, any>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, any> => Boolean(objectValue(item)))
    : [];
}

function countValue(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : null;
}

function phaseValue(value: unknown): string | null {
  return typeof value === "string" &&
    (SYNC_PHASES as readonly string[]).includes(value)
    ? value
    : null;
}

function completedPhasesValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(phaseValue).filter((phase): phase is string => phase !== null)
    : [];
}

function errorCodeValue(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z0-9_:-]{1,80}$/.test(value)
    ? value
    : null;
}

function safeCounterMap(value: unknown): Record<string, number> | null {
  const source = objectValue(value);
  if (!source) return null;
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(source)) {
    if (/^[A-Z0-9_:-]{1,80}$/.test(key) && typeof count === "number" && Number.isFinite(count)) {
      result[key] = Math.max(0, Math.trunc(count));
    }
  }
  return result;
}

function uniqueRunIds(rows: Array<Record<string, any>>): string[] {
  return [...new Set(rows.map((row) => row.id).filter((id): id is string => typeof id === "string"))];
}

function queryState<T>(result: QueryResult<T>, hasData: boolean): EvidenceReadStatus {
  if (!result.ok) return "UNKNOWN";
  return hasData ? "FOUND" : "NOT_FOUND";
}

function isCompleteRead(result: QueryResult<unknown>): boolean {
  return result.ok;
}

function latestPhase(rows: Array<Record<string, any>>): string | null {
  if (rows.length !== 1) return null;
  const phases = completedPhasesValue(rows[0].completed_phases);
  return [...phases].reverse().find((phase) => phase !== "COMPLETED") ??
    (phases.includes("COMPLETED") ? "COMPLETED" : null);
}

function matchingRows(
  result: QueryResult<unknown>,
  source: string,
  namedQueries: NamedQuery[],
  maxRows: number,
): Array<Record<string, any>> {
  namedQueries.push({ source, result });
  if (!result.ok) return [];
  const rows = rowsValue(result.data);
  if (result.count !== null && result.count > rows.length && rows.length >= maxRows) {
    namedQueries.push({
      source: source + ":limit",
      result: { ok: false, errorCode: "OBSERVABILITY_RESULT_LIMIT_REACHED" },
    });
  }
  return rows;
}

function metricFromCounts(
  rows: Array<Record<string, any>>,
  status: string,
): number {
  return rows.filter((row) => String(row.status ?? "").toUpperCase() === status).length;
}

function uniqueMessages(rows: Array<Record<string, any>>): {
  successes: number;
  failures: number;
  lastSentAt: string | null;
} {
  const successfulMessages = new Set<string>();
  const failedMessages = new Set<string>();
  const sentTimes: string[] = [];

  for (const row of rows) {
    const status = String(row.status ?? "").toUpperCase();
    const messageId = row.telegram_message_id == null ? null : String(row.telegram_message_id);
    const sentAt = typeof row.sent_at === "string" ? row.sent_at : null;
    const updatedAt = typeof row.updated_at === "string" ? row.updated_at : null;
    if (status === "SENT" || status === "SUCCESS") {
      successfulMessages.add(messageId ? "id:" + messageId : "sent:" + (sentAt ?? updatedAt ?? "unknown"));
      if (sentAt) sentTimes.push(sentAt);
    } else if (status === "FAILED") {
      failedMessages.add(updatedAt ? "failed:" + updatedAt : "row:" + String(row.id ?? failedMessages.size));
    }
  }

  sentTimes.sort((left, right) => Date.parse(right) - Date.parse(left));
  return {
    successes: successfulMessages.size,
    failures: failedMessages.size,
    lastSentAt: sentTimes[0] ?? null,
  };
}

function sumValues(values: Array<number | null>): number | null {
  if (values.some((value) => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sourceErrorList(queries: NamedQuery[]) {
  return queries
    .filter((item) => !item.result.ok)
    .map((item) => ({
      source: item.source,
      error_code: item.result.ok ? null : item.result.errorCode,
    }));
}

export async function collectCheckpointEvidence(
  checkpointAt: string,
  client: SupabaseClient = createAdminClient(),
  now: Date = new Date(),
) {
  const observedAt = now.toISOString();
  const namedQueries: NamedQuery[] = [];

  const [
    syncRunsResult,
    runningCountResult,
    lockResult,
    auditResult,
    recoveryResult,
    phase2Result,
    cronResult,
  ] = await Promise.all([
    readResult<Array<Record<string, any>>>(
      client
        .from("sync_runs")
        .select(SYNC_RUN_FIELDS, { count: "exact" })
        .eq("checkpoint_at", checkpointAt)
        .order("started_at", { ascending: true })
        .limit(20),
    ),
    readResult<unknown>(
      client
        .from("sync_runs")
        .select("id", { count: "exact", head: true })
        .eq("status", "running"),
    ),
    readResult<Record<string, any> | null>(
      client
        .from("sync_locks")
        .select("lock_key,owner_id,acquired_at,expires_at,heartbeat_at")
        .eq("lock_key", "global:rillnet-sync")
        .maybeSingle(),
    ),
    readResult<Record<string, any> | null>(
      client
        .from("checkpoint_dispatch_audits")
        .select(AUDIT_FIELDS)
        .eq("checkpoint_at", checkpointAt)
        .maybeSingle(),
    ),
    readResult<Record<string, any> | null>(
      client
        .from("checkpoint_recoveries")
        .select("status,scheduled_for,started_at,completed_at,sync_run_id,failure_stage,last_safe_error")
        .eq("checkpoint_at", checkpointAt)
        .maybeSingle(),
    ),
    readResult<Record<string, any> | null>(
      client
        .from("phase2_checkpoint_work")
        .select("status,attempt_count,started_at,completed_at,last_safe_error")
        .eq("checkpoint_at", checkpointAt)
        .maybeSingle(),
    ),
    readResult<Record<string, any>>(
      client.rpc("opspilot_checkpoint_cron_evidence", { p_checkpoint_at: checkpointAt }),
    ),
  ]);

  namedQueries.push(
    { source: "sync_runs", result: syncRunsResult },
    { source: "sync_runs.running_count", result: runningCountResult },
    { source: "sync_locks", result: lockResult },
    { source: "checkpoint_dispatch_audits", result: auditResult },
    { source: "checkpoint_recoveries", result: recoveryResult },
    { source: "phase2_checkpoint_work", result: phase2Result },
    { source: "cron.job+cron.job_run_details", result: cronResult },
  );

  const syncRows = rowsValue(syncRunsResult.ok ? syncRunsResult.data : null);
  const syncRecordCount = syncRunsResult.ok
    ? (syncRunsResult.count ?? syncRows.length)
    : null;
  const runIds = uniqueRunIds(syncRows);
  const runIdsAvailable = syncRunsResult.ok && runIds.length > 0;
  const cohort = checkpointKey(Date.parse(checkpointAt));
  const audit = auditResult.ok ? objectValue(auditResult.data) : null;
  const auditStart = textValue(audit?.started_at);
  const auditEnd = textValue(audit?.completed_at);

  const [
    manifestsResult,
    observationCountResult,
    snapshotCountResult,
    statusUpdatesResult,
    statusReportsResult,
    cohortCasesResult,
    reviewRequestsResult,
  ] = await Promise.all([
    runIdsAvailable
      ? readResult<Array<Record<string, any>>>(
          client
            .from("inbound_population_manifests")
            .select(MANIFEST_FIELDS, { count: "exact" })
            .in("sync_run_id", runIds)
            .order("source_system")
            .limit(100),
        )
      : Promise.resolve(notApplicable<Array<Record<string, any>>>()),
    runIdsAvailable
      ? readResult<unknown>(
          client
            .from("inbound_order_observations")
            .select("id", { count: "exact", head: true })
            .in("sync_run_id", runIds),
        )
      : Promise.resolve(notApplicable<unknown>()),
    runIdsAvailable
      ? readResult<unknown>(
          client
            .from("order_snapshots")
            .select("id", { count: "exact", head: true })
            .in("sync_run_id", runIds),
        )
      : Promise.resolve(notApplicable<unknown>()),
    runIdsAvailable
      ? readResult<Array<Record<string, any>>>(
          client
            .from("telegram_incident_status_updates")
            .select("id,status,sent_at,telegram_message_id,updated_at,update_kind", { count: "exact" })
            .in("sync_run_id", runIds)
            .limit(5000),
        )
      : Promise.resolve(notApplicable<Array<Record<string, any>>>()),
    runIdsAvailable
      ? readResult<Array<Record<string, any>>>(
          client
            .from("telegram_sync_status_reports")
            .select("id,status,sent_at,telegram_message_id,updated_at,resolved_cases", { count: "exact" })
            .in("sync_run_id", runIds)
            .limit(20),
        )
      : Promise.resolve(notApplicable<Array<Record<string, any>>>()),
    cohort
      ? readResult<Array<Record<string, any>>>(
          client
            .from("followup_cases")
            .select("id", { count: "exact" })
            .contains("operational_cohort", { lastCheckpoint: cohort })
            .limit(1000),
        )
      : Promise.resolve(notApplicable<Array<Record<string, any>>>()),
    auditStart && auditEnd
      ? readResult<Array<Record<string, any>>>(
          client
            .from("telegram_rillnet_review_requests")
            .select("id,status,sent_at,updated_at", { count: "exact" })
            .eq("created_by", "telegram_followup_pilot")
            .gte("created_at", auditStart)
            .lte("created_at", auditEnd)
            .limit(1000),
        )
      : Promise.resolve(notApplicable<Array<Record<string, any>>>()),
  ]);

  const manifestRows = matchingRows(
    manifestsResult,
    "inbound_population_manifests",
    namedQueries,
    100,
  );
  const statusUpdateRows = matchingRows(
    statusUpdatesResult,
    "telegram_incident_status_updates",
    namedQueries,
    5000,
  );
  const statusReportRows = matchingRows(
    statusReportsResult,
    "telegram_sync_status_reports",
    namedQueries,
    20,
  );
  const cohortCaseRows = matchingRows(
    cohortCasesResult,
    "followup_cases.operational_cohort",
    namedQueries,
    1000,
  );
  const reviewRows = matchingRows(
    reviewRequestsResult,
    "telegram_rillnet_review_requests",
    namedQueries,
    1000,
  );

  const cohortCaseIds = cohortCaseRows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string");
  const reminderResult = cohortCaseIds.length
    ? await readResult<Array<Record<string, any>>>(
        client
          .from("telegram_followup_reminders")
          .select(DELIVERY_FIELDS, { count: "exact" })
          .in("followup_case_id", cohortCaseIds)
          .limit(5000),
      )
    : cohortCasesResult.ok
      ? { ok: true as const, data: [] as Array<Record<string, any>>, count: 0 }
      : notApplicable<Array<Record<string, any>>>();
  const reminderRows = matchingRows(
    reminderResult,
    "telegram_followup_reminders",
    namedQueries,
    5000,
  );

  const syncReadState = queryState(syncRunsResult, syncRows.length > 0);
  const lockRow = lockResult.ok ? objectValue(lockResult.data) : null;
  const lockExpiration = textValue(lockRow?.expires_at);
  const activeSyncLock = lockResult.ok
    ? Boolean(lockExpiration && Date.parse(lockExpiration) > Date.parse(observedAt))
    : null;
  const runSummaries = syncRows.map((row) => ({
    sync_run_id: textValue(row.id),
    checkpoint_at: textValue(row.checkpoint_at),
    sync_status: textValue(row.status),
    current_phase: phaseValue(row.current_phase),
    completed_phases: completedPhasesValue(row.completed_phases),
    started_at: textValue(row.started_at),
    completed_at: textValue(row.completed_at),
    duration_ms: countValue(row.duration_ms),
    sync_error_code: errorCodeValue(row.error_code),
    sync_error_message: redactDiagnosticMessage(row.error_message),
    fetched_member_count: countValue(row.fetched_order_count),
  }));
  const singleRun = runSummaries.length === 1 ? runSummaries[0] : null;

  const manifestCount = manifestsResult.ok
    ? (manifestsResult.count ?? manifestRows.length)
    : null;
  const expectedMemberCount = manifestsResult.ok && manifestRows.length === (manifestsResult.count ?? manifestRows.length)
    ? sumValues(manifestRows.map((row) => countValue(row.expected_observation_count)))
    : null;
  const persistedMemberCount = manifestsResult.ok && manifestRows.length === (manifestsResult.count ?? manifestRows.length)
    ? sumValues(manifestRows.map((row) => countValue(row.persisted_observation_count)))
    : null;
  const actualMemberCount = observationCountResult.ok
    ? countValue(observationCountResult.count)
    : null;
  const manifestRowsComplete =
    manifestRows.length > 0 &&
    manifestRows.every((row) => row.population_status === "COMPLETE") &&
    manifestRows.every((row) => Number(row.expected_observation_count) === Number(row.persisted_observation_count)) &&
    manifestRows.every((row) => Number(row.duplicate_conflict_count ?? 0) === 0);

  let generationStatus: string;
  if (!runIdsAvailable) {
    generationStatus = syncRunsResult.ok ? "NOT_FOUND" : "UNKNOWN";
  } else if (!manifestsResult.ok || !observationCountResult.ok) {
    generationStatus = "UNKNOWN";
  } else if (manifestRows.length === 0) {
    generationStatus = "NOT_FOUND";
  } else if (manifestRows.some((row) => row.population_status === "FAILED")) {
    generationStatus = "FAILED";
  } else if (
    manifestRowsComplete &&
    expectedMemberCount !== null &&
    actualMemberCount !== null &&
    expectedMemberCount === persistedMemberCount &&
    persistedMemberCount === actualMemberCount
  ) {
    generationStatus = "COMPLETE";
  } else {
    generationStatus = "INCOMPLETE";
  }

  const cronPayload = cronResult.ok ? objectValue(cronResult.data) : null;
  const cronJob = objectValue(cronPayload?.job);
  const cronRuns = rowsValue(cronPayload?.runs).map((row) => ({
    cron_job_id: countValue(row.job_id),
    run_id: countValue(row.run_id),
    start_time: textValue(row.start_time),
    end_time: textValue(row.end_time),
    status: textValue(row.status),
    return_message: redactDiagnosticMessage(row.return_message),
  }));
  const latestCronRun = cronRuns.length ? cronRuns[cronRuns.length - 1] : null;
  const cronJobFound = cronResult.ok && cronPayload?.job_found === true && cronJob !== null;
  const cronExecutionFound = cronResult.ok && cronJobFound ? cronRuns.length > 0 : null;

  const auditFound = audit !== null;
  const auditErrorMessage = redactDiagnosticMessage(audit?.error_message_safe);
  const recovery = recoveryResult.ok ? objectValue(recoveryResult.data) : null;
  const phase2 = phase2Result.ok ? objectValue(phase2Result.data) : null;

  const manifestView = manifestRows.map((row) => ({
    source_system: textValue(row.source_system),
    status: textValue(row.population_status),
    expected_member_count: countValue(row.expected_observation_count),
    persisted_member_count: countValue(row.persisted_observation_count),
    duplicate_identical_count: countValue(row.duplicate_identical_count),
    duplicate_conflict_count: countValue(row.duplicate_conflict_count),
    completed_at: textValue(row.population_completed_at),
  }));

  const reminderMetrics = uniqueMessages(reminderRows);
  const statusUpdateMetrics = uniqueMessages(statusUpdateRows);
  const statusReportMetrics = uniqueMessages(statusReportRows);
  const reviewMetrics = uniqueMessages(reviewRows);
  const telegramQueryComplete =
    reminderResult.ok &&
    statusUpdatesResult.ok &&
    statusReportsResult.ok &&
    reviewRequestsResult.ok;
  const telegramSuccessCount = telegramQueryComplete
    ? reminderMetrics.successes + statusUpdateMetrics.successes + statusReportMetrics.successes + reviewMetrics.successes
    : null;
  const telegramFailureCount = telegramQueryComplete
    ? reminderMetrics.failures + statusUpdateMetrics.failures + statusReportMetrics.failures + reviewMetrics.failures
    : null;
  const sentAtValues = [
    reminderMetrics.lastSentAt,
    statusUpdateMetrics.lastSentAt,
    statusReportMetrics.lastSentAt,
    reviewMetrics.lastSentAt,
  ].filter((value): value is string => Boolean(value));
  sentAtValues.sort((left, right) => Date.parse(right) - Date.parse(left));
  const telegramSourceHasEvidence =
    (telegramSuccessCount ?? 0) > 0 ||
    (telegramFailureCount ?? 0) > 0 ||
    countValue(audit?.send_attempts) !== null && Number(audit?.send_attempts) > 0;

  const reads = namedQueries.filter(
    (item) => !(item.result.ok && item.result.notApplicable === true),
  );
  const failedReads = reads.filter((item) => !item.result.ok).length;
  const successfulReads = reads.length - failedReads;
  const observabilityStatus =
    failedReads === 0
      ? "PASS"
      : successfulReads > 0
        ? "PARTIAL"
        : "BLOCKED";

  const evidenceSources = {
    sync: { source: "sync_runs", status: syncReadState },
    concurrency: {
      source: "sync_runs + sync_locks",
      status:
        runningCountResult.ok && lockResult.ok
          ? "FOUND"
          : "UNKNOWN",
    },
    cron: {
      source: "public.opspilot_checkpoint_cron_evidence → cron.job + cron.job_run_details",
      status: !cronResult.ok
        ? "UNKNOWN"
        : cronJobFound
          ? cronRuns.length ? "FOUND" : "NOT_FOUND"
          : "NOT_FOUND",
    },
    checkpoint_audit: {
      source: "checkpoint_dispatch_audits",
      status: queryState(auditResult, auditFound),
    },
    recovery: {
      source: "checkpoint_recoveries",
      status: queryState(recoveryResult, recovery !== null),
    },
    phase2: {
      source: "phase2_checkpoint_work",
      status: queryState(phase2Result, phase2 !== null),
    },
    generation: {
      source: "inbound_population_manifests + inbound_order_observations",
      status: !runIdsAvailable
        ? syncRunsResult.ok ? "NOT_APPLICABLE" : "UNKNOWN"
        : !manifestsResult.ok || !observationCountResult.ok
          ? "UNKNOWN"
          : manifestRows.length ? "FOUND" : "NOT_FOUND",
    },
    pointers: {
      source: "not present in current runtime schema",
      status: "NOT_IMPLEMENTED_IN_CURRENT_ARCHITECTURE",
    },
    dispatch: {
      source: "checkpoint_dispatch_audits",
      status: queryState(auditResult, auditFound),
    },
    telegram: {
      source: "telegram_followup_reminders + telegram_incident_status_updates + telegram_sync_status_reports + telegram_rillnet_review_requests",
      status: telegramQueryComplete ? telegramSourceHasEvidence ? "FOUND" : "NOT_FOUND" : "UNKNOWN",
    },
  };

  return {
    metadata: {
      requested_checkpoint_at: checkpointAt,
      checkpoint_timezone: "Asia/Ho_Chi_Minh",
      observed_at: observedAt,
      observability_status: observabilityStatus,
      evidence_sources: evidenceSources,
    },
    sync: {
      source: "sync_runs",
      state: syncReadState,
      sync_run_id: singleRun?.sync_run_id ?? null,
      sync_status: singleRun?.sync_status ?? (syncRows.length > 1 ? "MULTIPLE" : null),
      current_phase: singleRun?.current_phase ?? null,
      completed_phases: singleRun?.completed_phases ?? [],
      started_at: singleRun?.started_at ?? null,
      completed_at: singleRun?.completed_at ?? null,
      duration_ms: singleRun?.duration_ms ?? null,
      sync_error_code: singleRun?.sync_error_code ?? null,
      sync_error_message: singleRun?.sync_error_message ?? null,
      sync_run_count: syncRecordCount,
      duplicate_sync_run_count:
        syncRecordCount === null ? null : Math.max(0, syncRecordCount - 1),
      runs: runSummaries,
      last_confirmed_phase: latestPhase(syncRows),
    },
    concurrency: {
      source: "sync_runs + sync_locks",
      current_running_count: runningCountResult.ok
        ? countValue(runningCountResult.count)
        : null,
      active_sync_lock: activeSyncLock,
      lock_owner: textValue(lockRow?.owner_id),
      lock_run_id: null,
      lock_run_id_status: lockRow
        ? "NOT_LINKED_IN_CURRENT_SCHEMA"
        : lockResult.ok
          ? "NOT_FOUND"
          : "UNKNOWN",
      lock_acquired_at: textValue(lockRow?.acquired_at),
      lock_expires_at: lockExpiration,
      lock_heartbeat_at: textValue(lockRow?.heartbeat_at),
    },
    cron: {
      source: "public.opspilot_checkpoint_cron_evidence",
      cron_job_name: cronJobFound ? textValue(cronJob?.job_name) : "opspilot-followup-cycle-mb3",
      cron_job_id: cronJobFound ? countValue(cronJob?.job_id) : null,
      cron_job_found: cronResult.ok ? cronJobFound : null,
      cron_enabled: cronJobFound ? Boolean(cronJob?.active) : null,
      cron_schedule: cronJobFound ? textValue(cronJob?.schedule) : null,
      cron_execution_found: cronExecutionFound,
      cron_execution_state: !cronResult.ok
        ? "UNKNOWN"
        : !cronJobFound
          ? "NOT_FOUND"
          : cronRuns.length
            ? "FOUND"
            : "NOT_FOUND",
      cron_start: latestCronRun?.start_time ?? null,
      cron_end: latestCronRun?.end_time ?? null,
      cron_status: latestCronRun?.status ?? "UNKNOWN",
      cron_return_message: latestCronRun?.return_message ?? null,
      cron_runs: cronRuns,
    },
    checkpoint_audit: {
      source: "checkpoint_dispatch_audits",
      checkpoint_audit_found: auditResult.ok ? auditFound : null,
      checkpoint_audit_status: textValue(audit?.execution_status) ?? "UNKNOWN",
      http_status: countValue(audit?.http_status),
      audit_error_code: errorCodeValue(audit?.error_code),
      audit_error_message: auditErrorMessage,
      failure_stage: textValue(recovery?.failure_stage),
      started_at: textValue(audit?.started_at),
      completed_at: textValue(audit?.completed_at),
      created_at: textValue(audit?.created_at),
      updated_at: null,
      last_confirmed_phase: latestPhase(syncRows),
      counts: {
        eligible_count: countValue(audit?.total_dispatch_eligible_pending),
        first_push_count: countValue(audit?.first_push_pending_created),
        second_push_count: countValue(audit?.second_push_pending_created),
        third_push_count: countValue(audit?.third_push_pending_created),
        escalation_count: countValue(audit?.escalation_pending_created),
        telegram_scanned: countValue(audit?.telegram_scanned),
        recipients_resolved: countValue(audit?.recipients_resolved),
        interactions_created: countValue(audit?.interactions_created),
        send_attempts: countValue(audit?.send_attempts),
        send_success: countValue(audit?.send_success),
        send_failed: countValue(audit?.send_failed),
        status_updates_active: countValue(audit?.status_updates_active),
        status_updates_resolved: countValue(audit?.status_updates_resolved),
        status_update_batches_sent: countValue(audit?.status_update_batches_sent),
        status_update_batches_failed: countValue(audit?.status_update_batches_failed),
        exclusion_counts: safeCounterMap(audit?.exclusion_counts),
      },
    },
    recovery: {
      source: "checkpoint_recoveries",
      state: queryState(recoveryResult, recovery !== null),
      status: textValue(recovery?.status),
      scheduled_for: textValue(recovery?.scheduled_for),
      started_at: textValue(recovery?.started_at),
      completed_at: textValue(recovery?.completed_at),
      sync_run_id: textValue(recovery?.sync_run_id),
      failure_stage: textValue(recovery?.failure_stage),
      last_safe_error: redactDiagnosticMessage(recovery?.last_safe_error),
    },
    phase2: {
      source: "phase2_checkpoint_work",
      state: queryState(phase2Result, phase2 !== null),
      status: textValue(phase2?.status),
      attempt_count: countValue(phase2?.attempt_count),
      started_at: textValue(phase2?.started_at),
      completed_at: textValue(phase2?.completed_at),
      last_safe_error: redactDiagnosticMessage(phase2?.last_safe_error),
    },
    generation: {
      source: "inbound_population_manifests + inbound_order_observations",
      generation_status: generationStatus,
      generation_id: null,
      generation_id_status: "NOT_IMPLEMENTED_IN_CURRENT_ARCHITECTURE",
      manifest_count: manifestCount,
      expected_member_count: expectedMemberCount,
      persisted_member_count: persistedMemberCount,
      actual_member_count: actualMemberCount,
      duplicate_generation_count: null,
      duplicate_generation_status: "NOT_IMPLEMENTED_IN_CURRENT_ARCHITECTURE",
      duplicate_sync_run_count:
        syncRecordCount === null ? null : Math.max(0, syncRecordCount - 1),
      generation_completed_at: manifestRows
        .map((row) => textValue(row.population_completed_at))
        .filter((value): value is string => Boolean(value))
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null,
      sync_fetched_member_count: sumValues(
        syncRows.map((row) => countValue(row.fetched_order_count)),
      ),
      legacy_snapshot_member_count: snapshotCountResult.ok
        ? countValue(snapshotCountResult.count)
        : null,
      manifests: manifestView,
    },
    publication: {
      source: "not present in current runtime schema",
      checkpoint_pointer_status: "NOT_IMPLEMENTED_IN_CURRENT_ARCHITECTURE",
      published_checkpoint_at: null,
      manifest_pointer_status: "NOT_IMPLEMENTED_IN_CURRENT_ARCHITECTURE",
      manifest_generation_id: null,
      pointer_updated_at: null,
    },
    dispatch: {
      source: "checkpoint_dispatch_audits",
      dispatcher_run_found: auditResult.ok ? auditFound : null,
      dispatcher_status: textValue(audit?.execution_status) ?? "UNKNOWN",
      eligible_count: countValue(audit?.total_dispatch_eligible_pending),
      first_push_count: countValue(audit?.first_push_pending_created),
      second_push_count: countValue(audit?.second_push_pending_created),
      third_push_count: countValue(audit?.third_push_pending_created),
      escalation_count: countValue(audit?.escalation_pending_created),
      resolved_count: countValue(audit?.status_updates_resolved),
      skipped_count: null,
      skipped_count_status: "NOT_PERSISTED_AS_A_CHECKPOINT_TOTAL",
      dispatch_error: auditErrorMessage,
    },
    telegram: {
      source:
        "telegram_followup_reminders + telegram_incident_status_updates + telegram_sync_status_reports + telegram_rillnet_review_requests",
      telegram_dispatch_found: telegramQueryComplete
        ? telegramSourceHasEvidence
        : null,
      telegram_message_count:
        telegramSuccessCount === null || telegramFailureCount === null
          ? null
          : telegramSuccessCount + telegramFailureCount,
      telegram_success_count: telegramSuccessCount,
      telegram_failure_count: telegramFailureCount,
      telegram_last_sent_at: sentAtValues[0] ?? null,
      audit_send_attempts: countValue(audit?.send_attempts),
      audit_send_success: countValue(audit?.send_success),
      audit_send_failed: countValue(audit?.send_failed),
      status: !telegramQueryComplete
        ? "UNKNOWN"
        : telegramSourceHasEvidence
          ? "FOUND"
          : "NOT_FOUND",
    },
    source_errors: sourceErrorList(namedQueries),
  };
}
