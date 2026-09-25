import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(`${process.cwd()}/package.json`);
const { createClient } = require("@supabase/supabase-js");

const GENERATION_ID = "9761bdc2-baff-46f1-9456-f881284663fb";
const BATCH_SIZE = 100;
const MEMBER_GENERATION_TABLE = "followup_case_member_generations";
const SELECT_COLUMNS = "followup_case_id,generation_id,source_sync_run_id,expected_member_count,generation_status";

function fail(code, detail = "") {
  throw new Error(`${code}${detail ? `: ${detail}` : ""}`);
}

function check(condition, code, detail = "") {
  if (!condition) fail(code, detail);
  console.log(`${code}=PASS${detail ? ` (${detail})` : ""}`);
}

function scrub(value) {
  return String(value ?? "")
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]")
    .replace(/\b(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1500);
}

function projectRefFromServiceKey(token) {
  const pieces = token.split(".");
  if (pieces.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(pieces[1], "base64url").toString("utf8"));
    return claims.role === "service_role" ? claims.ref ?? null : null;
  } catch {
    return null;
  }
}

function verifyProductionIdentity() {
  const expectedRef = process.env.EXPECTED_PRODUCTION_REF;
  const rejectedRef = process.env.REJECTED_SHADOW_REF;
  const apiUrl = new URL(process.env.SUPABASE_URL || "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const databaseUrl = new URL(process.env.SUPABASE_DATABASE_URL || "");
  const username = decodeURIComponent(databaseUrl.username).toLowerCase();
  const host = databaseUrl.hostname.toLowerCase();

  if (expectedRef !== "elwnbwimgzijuelfjdsq" || rejectedRef !== "qkrpbompjwxfpicjfoub") {
    fail("PROJECT_REFS_UNEXPECTED");
  }
  if (apiUrl.protocol !== "https:" || apiUrl.hostname !== `${expectedRef}.supabase.co`) {
    fail("PRODUCTION_API_IDENTITY", "URL is not the expected Production project");
  }
  if (apiUrl.hostname.includes(rejectedRef)) fail("SHADOW_PROJECT_REJECTED");

  const keyRef = projectRefFromServiceKey(key);
  if (keyRef && keyRef !== expectedRef) fail("PRODUCTION_SERVICE_KEY_IDENTITY", "key belongs to another project");
  if (!key) fail("PRODUCTION_SERVICE_KEY_MISSING");

  const directMatch = host === `db.${expectedRef}.supabase.co`;
  const poolerMatch = host.endsWith(".pooler.supabase.com") && username.includes(expectedRef);
  if (databaseUrl.protocol !== "postgresql:" && databaseUrl.protocol !== "postgres:") {
    fail("PRODUCTION_DATABASE_URL_IDENTITY", "unsupported database URL scheme");
  }
  if (!directMatch && !poolerMatch) {
    fail("PRODUCTION_DATABASE_URL_IDENTITY", "database endpoint cannot be tied to the expected Production project");
  }
  if (host.includes(rejectedRef) || username.includes(rejectedRef)) fail("SHADOW_DATABASE_REJECTED");

  console.log(`PRODUCTION_IDENTITY=PASS (${expectedRef}; Shadow ${rejectedRef} rejected)`);
}

function psqlSelect(sql, label) {
  const databaseUrl = process.env.SUPABASE_DATABASE_URL || "";
  const databasePassword = (() => {
    try { return decodeURIComponent(new URL(databaseUrl).password); } catch { return ""; }
  })();
  const result = spawnSync("psql", [
    "-X", "--set=ON_ERROR_STOP=1", "--no-align", "--tuples-only", "--quiet",
    "--command", `BEGIN READ ONLY; ${sql}; ROLLBACK;`,
  ], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      PGDATABASE: databaseUrl,
      PGSSLMODE: "require",
      PGCONNECT_TIMEOUT: "15",
      PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=8s",
    },
  });

  if (result.error || result.status !== 0) {
    let detail = String(result.stderr || result.error?.message || "psql failed");
    for (const secret of [databaseUrl, databasePassword]) {
      if (secret) detail = detail.replaceAll(secret, "[REDACTED_DATABASE_CREDENTIAL]");
    }
    fail(`${label}_QUERY_FAILED`, scrub(detail).slice(-1200));
  }

  const lines = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) fail(`${label}_OUTPUT_SHAPE`, `expected one JSON row; received ${lines.length}`);
  try {
    return JSON.parse(lines[0]);
  } catch {
    fail(`${label}_JSON_PARSE`, "read-only query did not return one JSON value");
  }
}

const IDENTITY_SQL = `
SELECT jsonb_build_object(
  'transaction_read_only', current_setting('transaction_read_only'),
  'database', current_database()
)::text
`;

const MANIFEST_STATS_SQL = `
WITH target AS (
  SELECT followup_case_id, source_sync_run_id, expected_member_count, generation_status
  FROM public.followup_case_member_generations
  WHERE generation_id = '${GENERATION_ID}'::uuid
)
SELECT jsonb_build_object(
  'manifest_count', count(*),
  'sum_expected_member_count', coalesce(sum(expected_member_count), 0),
  'min_expected_member_count', min(expected_member_count),
  'max_expected_member_count', max(expected_member_count),
  'zero_expected_member_count', count(*) FILTER (WHERE expected_member_count = 0),
  'status_counts', jsonb_build_object(
    'PREPARING', count(*) FILTER (WHERE generation_status = 'PREPARING'),
    'COMMITTED', count(*) FILTER (WHERE generation_status = 'COMMITTED'),
    'OTHER', count(*) FILTER (WHERE generation_status NOT IN ('PREPARING', 'COMMITTED'))
  ),
  'distinct_source_sync_run_ids', count(DISTINCT source_sync_run_id),
  'null_source_sync_run_ids', count(*) FILTER (WHERE source_sync_run_id IS NULL),
  'source_sync_run_ids_match_generation', coalesce(bool_and(source_sync_run_id = '${GENERATION_ID}'::uuid), false),
  'source_sync_run_rows_found', (
    SELECT count(DISTINCT s.id)
    FROM public.sync_runs AS s
    WHERE s.id IN (SELECT source_sync_run_id FROM target WHERE source_sync_run_id IS NOT NULL)
  ),
  'case_id_count', count(DISTINCT followup_case_id),
  'duplicate_case_ids', count(*) - count(DISTINCT followup_case_id)
)::text
FROM target
`;

const CASE_IDS_SQL = `
SELECT coalesce(jsonb_agg(followup_case_id::text ORDER BY followup_case_id::text), '[]'::jsonb)::text
FROM (
  SELECT DISTINCT followup_case_id
  FROM public.followup_case_member_generations
  WHERE generation_id = '${GENERATION_ID}'::uuid
) AS ordered_case_ids
`;

const RELATED_ROW_COUNTS_SQL = `
WITH target_cases AS (
  SELECT DISTINCT followup_case_id
  FROM public.followup_case_member_generations
  WHERE generation_id = '${GENERATION_ID}'::uuid
), case_incidents AS (
  SELECT fc.id::text AS case_id, fc.incident_id
  FROM public.followup_cases AS fc
  JOIN target_cases AS tc ON tc.followup_case_id = fc.id
)
SELECT jsonb_build_object(
  'member_rows', (SELECT count(*) FROM public.followup_case_members WHERE generation_id = '${GENERATION_ID}'::uuid),
  'pointers_to_failed_generation', (
    SELECT count(*) FROM public.followup_cases WHERE member_generation_id = '${GENERATION_ID}'::uuid
  ),
  'followup_events_for_manifest_cases', (
    SELECT count(*) FROM public.followup_events AS e WHERE e.followup_case_id IN (SELECT followup_case_id FROM target_cases)
  ),
  'notification_actions_for_manifest_cases', (
    SELECT count(*) FROM public.notification_actions AS a
    WHERE a.payload->>'incidentId' IN (SELECT incident_id FROM case_incidents)
       OR a.payload->>'followupCaseId' IN (SELECT case_id FROM case_incidents)
  ),
  'ai_analysis_jobs_for_manifest_cases', (
    SELECT count(*) FROM public.ai_analysis_jobs AS j
    WHERE j.incident_id::text IN (SELECT incident_id FROM case_incidents)
  ),
  'telegram_followup_reminders_for_manifest_cases', (
    SELECT count(*) FROM public.telegram_followup_reminders AS r
    WHERE r.followup_case_id IN (SELECT followup_case_id FROM target_cases)
  ),
  'telegram_followup_reminder_events_for_manifest_cases', (
    SELECT count(*) FROM public.telegram_followup_reminder_events AS e
    JOIN public.telegram_followup_reminders AS r ON r.id = e.reminder_id
    WHERE r.followup_case_id IN (SELECT followup_case_id FROM target_cases)
  )
)::text
`;

function manifestSummary(stats, ids) {
  const orderedIds = [...ids].sort();
  const digest = createHash("sha256").update(orderedIds.join("\n"), "utf8").digest("hex");
  return {
    caseIdCount: orderedIds.length,
    duplicateCaseIds: Number(stats.duplicate_case_ids),
    approximateRawIdListBytes: Buffer.byteLength(orderedIds.join(","), "utf8"),
    caseIdSha256: digest,
  };
}

function supabaseReadClient() {
  const baseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createClient(baseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (input, init = {}) => {
        const method = String(init.method || input?.method || "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") fail("REST_NON_READ_METHOD_BLOCKED", method);
        return fetch(input, { ...init, redirect: "error" });
      },
    },
  });
}

async function verifyManifestQuery(client, ids, label) {
  let request;
  try {
    request = client.from(MEMBER_GENERATION_TABLE)
      .select(SELECT_COLUMNS)
      .eq("generation_id", GENERATION_ID)
      .in("followup_case_id", ids)
      .retry(false);
  } catch (error) {
    return { label, httpStatus: null, statusText: null, requestUrlLength: null, rows: 0, error: { message: scrub(error?.message || error) } };
  }

  const requestUrlLength = Buffer.byteLength(String(request.url), "utf8");
  try {
    const result = await request;
    const error = result.error ? {
      code: result.error.code ?? null,
      message: scrub(result.error.message),
      details: scrub(result.error.details),
      hint: scrub(result.error.hint),
    } : null;
    return {
      label,
      httpStatus: result.status ?? null,
      statusText: result.statusText ?? null,
      requestUrlLength,
      rows: Array.isArray(result.data) ? result.data.length : 0,
      error,
    };
  } catch (error) {
    return {
      label,
      httpStatus: null,
      statusText: null,
      requestUrlLength,
      rows: 0,
      error: { message: scrub(error?.message || error) },
    };
  }
}

function writeStepSummary(lines) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) appendFileSync(path, `${lines.join("\n")}\n`);
}

async function main() {
  verifyProductionIdentity();
  const identity = psqlSelect(IDENTITY_SQL, "PRODUCTION_DATABASE_IDENTITY");
  check(identity.transaction_read_only === "on", "DATABASE_TRANSACTION_READ_ONLY");

  const stats = psqlSelect(MANIFEST_STATS_SQL, "MANIFEST_STATS");
  const caseIds = psqlSelect(CASE_IDS_SQL, "MANIFEST_CASE_IDS");
  const relatedCounts = psqlSelect(RELATED_ROW_COUNTS_SQL, "RELATED_ROW_COUNTS");
  const ids = Array.isArray(caseIds) ? caseIds : [];
  const manifestIdSummary = manifestSummary(stats, ids);

  console.log(`MANIFEST_COUNT=${stats.manifest_count}`);
  console.log(`EXPECTED_MEMBER_TOTAL=${stats.sum_expected_member_count}`);
  console.log(`MIN_EXPECTED_MEMBER_COUNT=${stats.min_expected_member_count ?? "NULL"}`);
  console.log(`MAX_EXPECTED_MEMBER_COUNT=${stats.max_expected_member_count ?? "NULL"}`);
  console.log(`ZERO_EXPECTED_MEMBER_COUNT=${stats.zero_expected_member_count}`);
  console.log(`MANIFEST_STATUS_COUNTS=${JSON.stringify(stats.status_counts)}`);
  console.log(`SOURCE_SYNC_RUN_CONSISTENCY=${JSON.stringify({ distinct: stats.distinct_source_sync_run_ids, nulls: stats.null_source_sync_run_ids, allMatchGeneration: stats.source_sync_run_ids_match_generation, referencedSyncRuns: stats.source_sync_run_rows_found })}`);
  console.log(`CASE_ID_COUNT=${manifestIdSummary.caseIdCount}`);
  console.log(`DUPLICATE_CASE_IDS=${manifestIdSummary.duplicateCaseIds}`);
  console.log(`CASE_ID_SHA256=${manifestIdSummary.caseIdSha256}`);
  console.log(`APPROX_RAW_ID_LIST_BYTES=${manifestIdSummary.approximateRawIdListBytes}`);
  console.log(`DATABASE_ROW_COUNTS=${JSON.stringify(relatedCounts)}`);

  const client = supabaseReadClient();
  const unbatched = ids.length ? await verifyManifestQuery(client, ids, "unbatched") : null;
  const batches = [];
  for (let start = 0; start < ids.length; start += BATCH_SIZE) {
    batches.push(await verifyManifestQuery(client, ids.slice(start, start + BATCH_SIZE), `batch-${batches.length}`));
  }

  const batchRows = batches.reduce((sum, batch) => sum + batch.rows, 0);
  const batchErrors = batches.filter((batch) => batch.error);
  const batchedPass = batchErrors.length === 0 && batchRows === Number(stats.manifest_count);
  const rootCauseConfirmed = unbatched?.httpStatus === 400 && batchedPass;

  console.log(`UNBATCHED_HTTP_STATUS=${unbatched?.httpStatus ?? "NO_RESPONSE"}`);
  console.log(`UNBATCHED_STATUS_TEXT=${scrub(unbatched?.statusText) || "UNKNOWN"}`);
  console.log(`UNBATCHED_ERROR_CODE=${unbatched?.error?.code ?? "NONE"}`);
  console.log(`UNBATCHED_ERROR_MESSAGE=${unbatched?.error?.message ?? "NONE"}`);
  console.log(`UNBATCHED_ERROR_DETAILS=${unbatched?.error?.details ?? "NONE"}`);
  console.log(`UNBATCHED_ERROR_HINT=${unbatched?.error?.hint ?? "NONE"}`);
  console.log(`UNBATCHED_REQUEST_URL_LENGTH=${unbatched?.requestUrlLength ?? "UNAVAILABLE"}`);
  console.log(`UNBATCHED_ROWS_RETURNED=${unbatched?.rows ?? 0}`);
  console.log(`BATCH_COUNT=${batches.length}`);
  console.log(`MAX_BATCH_URL_LENGTH=${batches.reduce((max, batch) => Math.max(max, batch.requestUrlLength || 0), 0)}`);
  console.log(`BATCHED_TOTAL_ROWS=${batchRows}`);
  console.log(`BATCHED_STATUS=${batchedPass ? "PASS" : "FAIL"}`);
  console.log(`ANY_BATCH_ERROR=${batchErrors.length ? JSON.stringify(batchErrors[0].error) : "NONE"}`);
  console.log(`ROOT_CAUSE_CONFIRMED=${rootCauseConfirmed ? "YES" : "NO"}`);
  console.log(`ROOT_CAUSE=${rootCauseConfirmed
    ? "The unbatched PostgREST manifest verification request returned HTTP 400 while identical 100-ID batches returned every manifest."
    : "Not confirmed by the required unbatched-versus-batched comparison; inspect the reported structured error and returned row counts."}`);

  const summary = [
    "## Production follow-up forensic (read-only)",
    `- Production identity: **PASS** (${process.env.EXPECTED_PRODUCTION_REF})`,
    `- Manifest count / expected members: **${stats.manifest_count} / ${stats.sum_expected_member_count}**`,
    `- Member rows / pointers: **${relatedCounts.member_rows} / ${relatedCounts.pointers_to_failed_generation}**`,
    `- Case IDs: **${manifestIdSummary.caseIdCount}**, duplicates **${manifestIdSummary.duplicateCaseIds}**, SHA-256 \`${manifestIdSummary.caseIdSha256}\``,
    `- Unbatched GET: HTTP **${unbatched?.httpStatus ?? "NO_RESPONSE"}**, URL length **${unbatched?.requestUrlLength ?? "unavailable"}**, rows **${unbatched?.rows ?? 0}**`,
    `- Batched GET: **${batches.length}** requests, **${batchRows}** rows, **${batchedPass ? "PASS" : "FAIL"}**`,
    `- Root cause confirmed: **${rootCauseConfirmed ? "YES" : "NO"}**`,
  ];
  writeStepSummary(summary);
}

main().catch((error) => {
  console.error(scrub(error?.message || error));
  process.exitCode = 1;
});
