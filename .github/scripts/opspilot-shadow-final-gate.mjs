import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const TARGET_REF = "qkrpbompjwxfpicjfoub";
const PRIMARY_REF = "elwnbwimgzijuelfjdsq";
const TARGET_COMMIT = "df3da8ac42902a67d60830b837019f2c6eee2b03";
const V3_TABLES = [
  "order_state_versions",
  "shadow_sync_runs",
  "snapshot_v3_shadow_comparisons",
  "sync_run_order_refs",
];
const STATE_FILE = process.env.STATE_FILE || resolve(process.env.RUNNER_TEMP || ".", "opspilot-shadow-final-gate-state.json");
const SERVICE_KEY = process.env.SHADOW_SERVICE_ROLE_KEY;
const HTTP_STATUS = {};

function check(condition, name, details = "") {
  if (!condition) throw new Error(`GATE_FAILED:${name}${details ? `:${details}` : ""}`);
  console.log(`${name}=PASS${details ? ` (${details})` : ""}`);
}

function safeError(value) {
  let message = value instanceof Error ? value.message : String(value);
  let databasePassword;
  try { databasePassword = new URL(process.env.SHADOW_DATABASE_URL).password && decodeURIComponent(new URL(process.env.SHADOW_DATABASE_URL).password); } catch { /* no valid URL to redact */ }
  for (const secret of [SERVICE_KEY, process.env.SHADOW_DATABASE_URL, databasePassword]) {
    if (secret) message = message.replaceAll(secret, "[REDACTED]");
  }
  return message.replace(/(postgres(?:ql)?:\/\/[^\s:@/]+:)[^@/]+@/gi, "$1[REDACTED]@");
}

function dbEnvironment() {
  const raw = process.env.SHADOW_DATABASE_URL;
  const apiRaw = process.env.SHADOW_SUPABASE_URL;
  if (!raw || !apiRaw || !SERVICE_KEY) throw new Error("GATE_FAILED:SHADOW_SECRETS_MISSING");
  if (process.env.SHADOW_PROJECT_REF && process.env.SHADOW_PROJECT_REF !== TARGET_REF) throw new Error("GATE_FAILED:WORKFLOW_SHADOW_REF_MISMATCH");
  if (process.env.CANDIDATE_SHA && process.env.CANDIDATE_SHA !== TARGET_COMMIT) throw new Error("GATE_FAILED:WORKFLOW_CANDIDATE_SHA_MISMATCH");

  const tokenParts = SERVICE_KEY.split(".");
  if (tokenParts.length !== 3) throw new Error("GATE_FAILED:SERVICE_ROLE_KEY_UNVERIFIABLE");
  let serviceClaims;
  try { serviceClaims = JSON.parse(Buffer.from(tokenParts[1], "base64url").toString("utf8")); }
  catch { throw new Error("GATE_FAILED:SERVICE_ROLE_KEY_UNVERIFIABLE"); }
  if (serviceClaims.ref !== TARGET_REF || serviceClaims.role !== "service_role") {
    throw new Error("GATE_FAILED:SERVICE_ROLE_KEY_PROJECT_OR_ROLE_MISMATCH");
  }

  const apiUrl = new URL(apiRaw);
  if (apiUrl.protocol !== "https:" || apiUrl.hostname !== `${TARGET_REF}.supabase.co`
    || !["", "/"].includes(apiUrl.pathname) || apiUrl.search || apiUrl.hash || apiUrl.username || apiUrl.password) {
    throw new Error("GATE_FAILED:SHADOW_API_URL_IDENTITY");
  }
  const databaseUrl = new URL(raw);
  if (!/^postgres(?:ql)?:$/.test(databaseUrl.protocol)) throw new Error("GATE_FAILED:DATABASE_URL_SCHEME");
  const dbUser = decodeURIComponent(databaseUrl.username);
  const directHost = databaseUrl.hostname === `db.${TARGET_REF}.supabase.co`;
  const poolerHost = databaseUrl.hostname.endsWith(".pooler.supabase.com")
    && dbUser === `postgres.${TARGET_REF}`;
  if (!directHost && !poolerHost) throw new Error("GATE_FAILED:DATABASE_TARGET_UNVERIFIABLE");
  if (`${databaseUrl.hostname} ${dbUser}`.includes(PRIMARY_REF)) throw new Error("GATE_FAILED:PRIMARY_DATABASE_REF_REJECTED");

  const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//, "")) || "postgres";
  return {
    apiUrl: apiUrl.origin,
    pg: {
      PGHOST: databaseUrl.hostname,
      PGPORT: databaseUrl.port || "5432",
      PGUSER: dbUser,
      PGPASSWORD: decodeURIComponent(databaseUrl.password),
      PGDATABASE: databaseName,
      PGSSLMODE: "require",
      PGCONNECT_TIMEOUT: "15",
      PGOPTIONS: "-c statement_timeout=8s",
    },
  };
}

function psql(sql, options = {}) {
  const { pg } = dbEnvironment();
  const args = ["-X", "-v", "ON_ERROR_STOP=1", "-A", "-t"];
  if (options.file) args.push("-f", options.file);
  else args.push("-c", sql);
  const result = spawnSync("psql", args, {
    encoding: "utf8",
    env: { ...process.env, ...pg },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = safeError(`${result.stderr || ""}${result.stdout || ""}`).trim();
    throw new Error(`PSQL_FAILED:${output.slice(-3000)}`);
  }
  return result.stdout.trim();
}

const V3_DIGEST_SQL = `
WITH target_tables(table_name) AS (
  VALUES ('order_state_versions'), ('shadow_sync_runs'),
         ('snapshot_v3_shadow_comparisons'), ('sync_run_order_refs')
), table_defs AS (
  SELECT t.table_name,
    jsonb_build_object(
      'columns', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'name', a.attname,
          'type', format_type(a.atttypid, a.atttypmod),
          'notNull', a.attnotnull,
          'default', pg_get_expr(d.adbin, d.adrelid),
          'identity', a.attidentity,
          'generated', a.attgenerated
        ) ORDER BY a.attnum)
        FROM pg_attribute AS a
        LEFT JOIN pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      ), '[]'::jsonb),
      'constraints', coalesce((
        SELECT jsonb_agg(jsonb_build_object('name', con.conname, 'definition', pg_get_constraintdef(con.oid, true)) ORDER BY con.conname)
        FROM pg_constraint AS con WHERE con.conrelid = c.oid
      ), '[]'::jsonb),
      'indexes', coalesce((
        SELECT jsonb_agg(jsonb_build_object('name', ic.relname, 'definition', pg_get_indexdef(i.indexrelid)) ORDER BY ic.relname)
        FROM pg_index AS i JOIN pg_class AS ic ON ic.oid = i.indexrelid
        WHERE i.indrelid = c.oid
      ), '[]'::jsonb),
      'rls', jsonb_build_object('enabled', c.relrowsecurity, 'forced', c.relforcerowsecurity),
      'policies', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'name', p.polname, 'command', p.polcmd, 'permissive', p.polpermissive,
          'roles', p.polroles, 'using', pg_get_expr(p.polqual, p.polrelid),
          'check', pg_get_expr(p.polwithcheck, p.polrelid)
        ) ORDER BY p.polname)
        FROM pg_policy AS p WHERE p.polrelid = c.oid
      ), '[]'::jsonb),
      'grants', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'grantee', coalesce(r.rolname, 'PUBLIC'),
          'privilege', x.privilege_type,
          'grantable', x.is_grantable
        ) ORDER BY coalesce(r.rolname, 'PUBLIC'), x.privilege_type)
        FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS x
        LEFT JOIN pg_roles AS r ON r.oid = x.grantee
      ), '[]'::jsonb)
    ) AS definition
  FROM target_tables AS t
  JOIN pg_namespace AS n ON n.nspname = 'public'
  JOIN pg_class AS c ON c.relnamespace = n.oid AND c.relname = t.table_name
), telemetry AS (
  SELECT p.oid, pg_get_functiondef(p.oid) AS definition,
    coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'grantee', coalesce(r.rolname, 'PUBLIC'),
        'privilege', x.privilege_type,
        'grantable', x.is_grantable
      ) ORDER BY coalesce(r.rolname, 'PUBLIC'), x.privilege_type)
      FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS x
      LEFT JOIN pg_roles AS r ON r.oid = x.grantee
    ), '[]'::jsonb) AS grants
  FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'snapshot_v3_storage_telemetry' AND p.pronargs = 0
)
SELECT md5(
  coalesce((SELECT string_agg(table_name || ':' || definition::text, E'\\n' ORDER BY table_name) FROM table_defs), '')
  || E'\\nFUNCTION:' || coalesce((SELECT definition FROM telemetry), 'MISSING')
  || E'\\nFUNCTION_GRANTS:' || coalesce((SELECT grants::text FROM telemetry), '[]')
);
`;

function candidateHead() {
  const directory = process.env.CANDIDATE_DIR;
  if (!directory) throw new Error("GATE_FAILED:CANDIDATE_DIR_MISSING");
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" });
  if (result.status !== 0) throw new Error("GATE_FAILED:CANDIDATE_GIT_UNAVAILABLE");
  return result.stdout.trim();
}

function ensureCandidate() {
  const actual = candidateHead();
  check(actual === TARGET_COMMIT, "EXACT_CANDIDATE_CHECKOUT", actual);
  return resolve(process.env.CANDIDATE_DIR, "src/database/migrations/094_normalized_followup_case_members.sql");
}

function preflight() {
  const migrationPath = ensureCandidate();
  if (!existsSync(migrationPath)) throw new Error("GATE_FAILED:CANDIDATE_MIGRATION_MISSING");
  const identity = psql(`
    DO $$ BEGIN
      IF to_regclass('public.shadow_sync_runs') IS NULL
        OR to_regclass('public.order_state_versions') IS NULL
        OR to_regclass('public.snapshot_v3_shadow_comparisons') IS NULL
        OR to_regclass('public.sync_run_order_refs') IS NULL
        OR to_regprocedure('public.snapshot_v3_storage_telemetry()') IS NULL THEN
        RAISE EXCEPTION 'V3_BASELINE_OBJECT_MISSING';
      END IF;
      IF to_regtype('public.followup_state_enum') IS NOT NULL
        OR to_regclass('public.sync_runs') IS NOT NULL
        OR to_regclass('public.followup_cases') IS NOT NULL
        OR to_regclass('public.checkpoint_recoveries') IS NOT NULL
        OR to_regclass('public.followup_case_members') IS NOT NULL
        OR to_regclass('public.followup_case_member_generations') IS NOT NULL
        OR to_regclass('public.followup_case_cohort_archive') IS NOT NULL THEN
        RAISE EXCEPTION 'TEMPORARY_TEST_OBJECT_ALREADY_EXISTS';
      END IF;
      IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) <> 3 THEN
        RAISE EXCEPTION 'SUPABASE_ROLES_MISSING';
      END IF;
    END $$;
    SELECT jsonb_build_object(
      'serverVersion', current_setting('server_version'),
      'serverVersionNum', current_setting('server_version_num')::integer,
      'statementTimeout', current_setting('statement_timeout'),
      'database', current_database()
    )::text;
  `);
  check(true, "SHADOW_IDENTITY_CHECK", "API and database endpoints matched Shadow project ref");
  check(true, "SERVICE_ROLE_KEY_IDENTITY", "service_role key claim matched Shadow project ref");
  check(true, "PRIMARY_REF_REJECTED");
  const version = JSON.parse(identity.split(/\r?\n/).at(-1));
  const counts = JSON.parse(psql(`
    SELECT jsonb_build_object(
      'shadow_sync_runs', (SELECT count(*) FROM public.shadow_sync_runs),
      'order_state_versions', (SELECT count(*) FROM public.order_state_versions),
      'snapshot_v3_shadow_comparisons', (SELECT count(*) FROM public.snapshot_v3_shadow_comparisons),
      'sync_run_order_refs', (SELECT count(*) FROM public.sync_run_order_refs)
    )::text;
  `));
  check(Object.values(counts).every((count) => Number(count) === 0), "V3_TABLES_EMPTY", JSON.stringify(counts));
  const digest = psql(V3_DIGEST_SQL);
  check(/^[0-9a-f]{32}$/.test(digest), "V3_SCHEMA_DIGEST_CAPTURED", digest);
  const state = { safe: true, projectRef: TARGET_REF, candidate: TARGET_COMMIT, digest, counts, version };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, "safe=true\n");
  console.log(`SHADOW_PROJECT_REF=${TARGET_REF}`);
  console.log(`PRIMARY_PROJECT_REF_REJECTED=${PRIMARY_REF}`);
  console.log(`DATABASE_VERSION=${version.serverVersion}`);
  console.log(`SESSION_STATEMENT_TIMEOUT=${version.statementTimeout}`);
  console.log(`V3_PRE_DIGEST=${digest}`);
}

const BOOTSTRAP_SQL = `
BEGIN;
CREATE TYPE public.followup_state_enum AS ENUM (
  'NEW', 'FIRST_PUSH_SENT', 'FOLLOWING_UP', 'SECOND_PUSH_SENT', 'ESCALATED', 'RESOLVED', 'CLOSED'
);
CREATE TABLE public.sync_runs (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('running', 'success', 'failed'))
);
CREATE TABLE public.followup_cases (
  id uuid PRIMARY KEY,
  current_state public.followup_state_enum NOT NULL DEFAULT 'NEW',
  operational_cohort jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.checkpoint_recoveries (
  checkpoint_at timestamptz PRIMARY KEY,
  sync_run_id uuid NULL REFERENCES public.sync_runs(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('PENDING', 'DISPATCHING', 'RUNNING', 'CONFIRMED', 'FAILED'))
);
ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.followup_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkpoint_recoveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sync_runs, public.followup_cases, public.checkpoint_recoveries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.sync_runs, public.followup_cases, public.checkpoint_recoveries TO service_role;
REVOKE ALL ON TYPE public.followup_state_enum FROM PUBLIC, anon, authenticated;
GRANT USAGE ON TYPE public.followup_state_enum TO service_role;
COMMIT;
`;

const TEST_RUNTIME_FUNCTION_SQL = `
CREATE FUNCTION public.opspilot_shadow_test_runtime_settings()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog
AS $$ SELECT jsonb_build_object('role', current_user, 'statement_timeout', current_setting('statement_timeout')) $$;
REVOKE ALL ON FUNCTION public.opspilot_shadow_test_runtime_settings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.opspilot_shadow_test_runtime_settings() TO service_role;
NOTIFY pgrst, 'reload schema';
`;

function runSql(sql) {
  return psql(sql);
}

function apiRequest(path, init = {}) {
  const { apiUrl } = dbEnvironment();
  const url = new URL(path, `${apiUrl}/rest/v1/`);
  const headers = new Headers(init.headers || {});
  headers.set("apikey", SERVICE_KEY);
  headers.set("authorization", `Bearer ${SERVICE_KEY}`);
  const start = performance.now();
  return fetch(url, { ...init, headers }).then(async (response) => {
    const durationMs = performance.now() - start;
    HTTP_STATUS[response.status] = (HTTP_STATUS[response.status] || 0) + 1;
    const text = await response.text();
    if (!response.ok) throw new Error(`POSTGREST_HTTP_${response.status}:${text.slice(0, 1200)}`);
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    return { response, body, durationMs, text };
  });
}

function rpcBody(value) {
  if (Array.isArray(value)) return value[0] ?? {};
  return value ?? {};
}

function uuid() { return randomUUID(); }

function pgLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlMember(caseId, generationId, sourceRunId, orderCode) {
  return `(${pgLiteral(caseId)}::uuid, ${pgLiteral(generationId)}::uuid, ${sourceRunId ? `${pgLiteral(sourceRunId)}::uuid` : "NULL"}, ${pgLiteral(orderCode)}, 'TEST-CUSTOMER', 'TEST-WAREHOUSE', 'DELIVERY', 'storing', now(), NULL, 'rillnet', 'storing', true, NULL, NULL, NULL, NULL, true, NULL)`;
}

function sqlGeneration(caseId, generationId, sourceRunId, createdAgo, committedAgo, status) {
  const created = `clock_timestamp() - interval '${createdAgo}'`;
  const committed = committedAgo === null ? "NULL" : `clock_timestamp() - interval '${committedAgo}'`;
  return `(${pgLiteral(caseId)}::uuid, ${pgLiteral(generationId)}::uuid, ${sourceRunId ? `${pgLiteral(sourceRunId)}::uuid` : "NULL"}, 1, ${pgLiteral(status)}, ${created}, ${committed})`;
}

async function postGeneration(caseId, generationId, expectedCount, createdAt = null) {
  const row = {
    followup_case_id: caseId,
    generation_id: generationId,
    source_sync_run_id: null,
    expected_member_count: expectedCount,
    generation_status: "PREPARING",
    ...(createdAt ? { created_at: createdAt } : {}),
  };
  return apiRequest("followup_case_member_generations?on_conflict=followup_case_id%2Cgeneration_id", {
    method: "POST",
    headers: { "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(row),
  });
}

async function postCase(caseId) {
  return apiRequest("followup_cases?on_conflict=id", {
    method: "POST",
    headers: { "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ id: caseId, current_state: "NEW", operational_cohort: {} }),
  });
}

function makeMember(caseId, generationId, index, prefix) {
  const completed = index % 10 === 0;
  return {
    followup_case_id: caseId,
    generation_id: generationId,
    source_sync_run_id: null,
    order_code: `${prefix}-${String(index).padStart(5, "0")}`,
    customer_id: `CUSTOMER-${index % 31}`,
    warehouse_id: `WAREHOUSE-${index % 9}`,
    stage: ["DELIVERY", "TRANSIT", "OUTBOUND", "UNKNOWN"][index % 4],
    status: index % 2 ? "transporting" : "storing",
    observed_at: "2026-09-24T03:00:00.000Z",
    ready_at: index % 7 ? "2026-09-24T02:00:00.000Z" : null,
    source: index % 11 ? "rillnet" : null,
    baseline_status: index % 2 ? "picked" : "storing",
    is_baseline: index % 2 === 0,
    due_at: index % 7 ? "2026-09-24T03:00:00.000Z" : null,
    last_reminder_at: index % 5 ? null : "2026-09-24T02:30:00.000Z",
    last_reminder_status: index % 5 ? null : "storing",
    completed_at: completed ? "2026-09-24T02:45:00.000Z" : null,
    member_active: !completed,
    verification_failure: index % 101 === 0 ? "BUDGET_DEFERRED" : null,
  };
}

function chunksFor(rows) {
  const chunks = [];
  let current = [];
  for (const row of rows) {
    const proposed = [...current, row];
    if (current.length && (proposed.length > 500 || Buffer.byteLength(JSON.stringify(proposed), "utf8") > 131072)) {
      chunks.push(current);
      current = [row];
    } else current = proposed;
    const bytes = Buffer.byteLength(JSON.stringify(current), "utf8");
    if (current.length > 500 || bytes > 131072) throw new Error("GATE_FAILED:CHUNK_BOUND_EXCEEDED");
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function writeMemberRows(caseId, generationId, count, prefix) {
  const rows = Array.from({ length: count }, (_, index) => makeMember(caseId, generationId, index, prefix));
  const chunks = chunksFor(rows);
  const durations = [];
  let maxChunkRows = 0;
  let maxChunkBytes = 0;
  for (const chunk of chunks) {
    const bytes = Buffer.byteLength(JSON.stringify(chunk), "utf8");
    maxChunkRows = Math.max(maxChunkRows, chunk.length);
    maxChunkBytes = Math.max(maxChunkBytes, bytes);
    const result = await apiRequest("followup_case_members?on_conflict=followup_case_id%2Cgeneration_id%2Corder_code", {
      method: "POST",
      headers: { "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(chunk),
    });
    durations.push(result.durationMs);
  }
  return { rows, chunks: chunks.length, durations, maxChunkRows, maxChunkBytes };
}

async function readMemberKeys(caseId, generationId, expectedCount) {
  const pageSize = 500;
  const keys = [];
  const durations = [];
  for (let offset = 0; offset < expectedCount; offset += pageSize) {
    const end = Math.min(expectedCount - 1, offset + pageSize - 1);
    const result = await apiRequest(
      `followup_case_members?select=order_code&followup_case_id=eq.${caseId}&generation_id=eq.${generationId}&order=order_code.asc`,
      { method: "GET", headers: { Range: `${offset}-${end}`, Prefer: "count=exact" } },
    );
    if (!Array.isArray(result.body)) throw new Error("GATE_FAILED:POSTGREST_READ_SHAPE");
    keys.push(...result.body.map((row) => row.order_code));
    durations.push(result.durationMs);
  }
  check(keys.length === expectedCount, "POSTGREST_EXACT_MEMBER_COUNT", String(keys.length));
  check(new Set(keys).size === expectedCount, "POSTGREST_MEMBER_KEY_SET_UNIQUE");
  return { keys, maxMs: Math.max(0, ...durations) };
}

async function setGenerationCommitted(caseId, generationId, count) {
  const result = await apiRequest(`followup_case_member_generations?followup_case_id=eq.${caseId}&generation_id=eq.${generationId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ generation_status: "COMMITTED", committed_at: new Date().toISOString(), expected_member_count: count }),
  });
  if (!Array.isArray(result.body) || result.body.length !== 1) throw new Error("GATE_FAILED:POSTGREST_GENERATION_COMMIT_SHAPE");
  return result.durationMs;
}

async function flipPointer(caseId, generationId, count) {
  const result = await apiRequest(`followup_cases?id=eq.${caseId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({
      cohort_version: 2,
      member_generation_id: generationId,
      operational_cohort: {
        version: 2,
        day: "2026-09-24",
        capturedAt: "2026-09-24T03:00:00.000Z",
        memberStore: "followup_case_members",
        memberCount: count,
        baselineCount: Math.ceil(count / 2),
      },
    }),
  });
  if (!Array.isArray(result.body) || result.body.length !== 1) throw new Error("GATE_FAILED:POSTGREST_POINTER_SHAPE");
  if (result.body[0].member_generation_id !== generationId || result.body[0].cohort_version !== 2) throw new Error("GATE_FAILED:POSTGREST_POINTER_VALUE");
  return result.durationMs;
}

async function callCleanup(dryRun, caseLimit = 5, memberLimit = 5000) {
  const result = await apiRequest("rpc/cleanup_followup_case_member_generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ p_dry_run: dryRun, p_case_limit: caseLimit, p_member_delete_limit: memberLimit }),
  });
  const body = rpcBody(result.body);
  if (typeof body !== "object" || body === null || !("dryRun" in body)) throw new Error("GATE_FAILED:POSTGREST_RPC_RESPONSE_SHAPE");
  return { body, durationMs: result.durationMs, status: result.response.status };
}

function seedCleanupCore() {
  const caseId = uuid();
  const activeCase = uuid();
  const recoveryCase = uuid();
  const activeRun = uuid();
  const recoveryRun = uuid();
  const checkpointAt = "2020-01-01T00:00:00Z";
  const core = [uuid(), uuid(), uuid(), uuid(), uuid()];
  const active = [uuid(), uuid(), uuid()];
  const recovery = [uuid(), uuid(), uuid()];
  const cases = [caseId, activeCase, recoveryCase];
  const generations = [
    sqlGeneration(caseId, core[0], null, "30 days", "30 days", "COMMITTED"),
    sqlGeneration(caseId, core[1], null, "2 days", "2 days", "COMMITTED"),
    sqlGeneration(caseId, core[2], null, "1 day", "1 day", "COMMITTED"),
    sqlGeneration(caseId, core[3], null, "8 days", null, "PREPARING"),
    sqlGeneration(caseId, core[4], null, "6 days", null, "PREPARING"),
    sqlGeneration(activeCase, active[0], null, "30 days", "30 days", "COMMITTED"),
    sqlGeneration(activeCase, active[1], null, "2 days", "2 days", "COMMITTED"),
    sqlGeneration(activeCase, active[2], activeRun, "10 days", "10 days", "COMMITTED"),
    sqlGeneration(recoveryCase, recovery[0], null, "30 days", "30 days", "COMMITTED"),
    sqlGeneration(recoveryCase, recovery[1], null, "2 days", "2 days", "COMMITTED"),
    sqlGeneration(recoveryCase, recovery[2], recoveryRun, "10 days", "10 days", "COMMITTED"),
  ];
  const statements = [
    `INSERT INTO public.followup_cases(id) VALUES ${cases.map((id) => `(${pgLiteral(id)}::uuid)`).join(",")};`,
    `INSERT INTO public.sync_runs(id,status) VALUES (${pgLiteral(activeRun)}::uuid,'running'),(${pgLiteral(recoveryRun)}::uuid,'success');`,
    `INSERT INTO public.checkpoint_recoveries(checkpoint_at,sync_run_id,status) VALUES (${pgLiteral(checkpointAt)}::timestamptz,${pgLiteral(recoveryRun)}::uuid,'PENDING');`,
    `INSERT INTO public.followup_case_member_generations(followup_case_id,generation_id,source_sync_run_id,expected_member_count,generation_status,created_at,committed_at) VALUES ${generations.join(",")};`,
    `UPDATE public.followup_cases SET member_generation_id=${pgLiteral(core[2])}::uuid,cohort_version=2 WHERE id=${pgLiteral(caseId)}::uuid;`,
    `UPDATE public.followup_cases SET member_generation_id=${pgLiteral(active[1])}::uuid,cohort_version=2 WHERE id=${pgLiteral(activeCase)}::uuid;`,
    `UPDATE public.followup_cases SET member_generation_id=${pgLiteral(recovery[1])}::uuid,cohort_version=2 WHERE id=${pgLiteral(recoveryCase)}::uuid;`,
    `INSERT INTO public.followup_case_members(followup_case_id,generation_id,source_sync_run_id,order_code,customer_id,warehouse_id,stage,status,observed_at,ready_at,source,baseline_status,is_baseline,due_at,last_reminder_at,last_reminder_status,completed_at,member_active,verification_failure) VALUES ` + [
      [caseId, core[0], null, "CORE-G1"], [caseId, core[1], null, "CORE-G2"], [caseId, core[2], null, "CORE-G3"], [caseId, core[3], null, "CORE-G4"], [caseId, core[4], null, "CORE-G5"],
      [activeCase, active[0], null, "ACTIVE-G1"], [activeCase, active[1], null, "ACTIVE-G2"], [activeCase, active[2], activeRun, "ACTIVE-G3"],
      [recoveryCase, recovery[0], null, "RECOVERY-G1"], [recoveryCase, recovery[1], null, "RECOVERY-G2"], [recoveryCase, recovery[2], recoveryRun, "RECOVERY-G3"],
    ].map(([c, g, sourceRun, code]) => sqlMember(c, g, sourceRun, code)).join(",") + ";",
  ];
  runSql(`BEGIN; ${statements.join("\n")} COMMIT;`);
  return { caseId, core, activeCase, active, recoveryCase, recovery, activeRun, recoveryRun };
}

async function cleanupSemantics(report) {
  const ids = seedCleanupCore();
  const dry = await callCleanup(true, 5, 5000);
  check(dry.body.eligibleGenerationsInBatch === 2, "CLEANUP_DRY_RUN", JSON.stringify(dry.body));
  check(dry.body.eligibleMemberRowsInBatch === 2, "CLEANUP_DRY_RUN_MEMBER_COUNT");
  const apply = await callCleanup(false, 5, 5000);
  check(apply.body.deletedGenerations === 2 && apply.body.deletedMemberRows === 2, "CLEANUP_APPLY", JSON.stringify(apply.body));
  const second = await callCleanup(false, 5, 5000);
  check(second.body.deletedGenerations === 0 && second.body.deletedMemberRows === 0, "CLEANUP_IDEMPOTENT", JSON.stringify(second.body));
  const result = JSON.parse(runSql(`
    SELECT jsonb_build_object(
      'G1Removed', NOT EXISTS (SELECT 1 FROM public.followup_case_member_generations WHERE followup_case_id=${pgLiteral(ids.caseId)}::uuid AND generation_id=${pgLiteral(ids.core[0])}::uuid),
      'G2PreviousPresent', EXISTS (SELECT 1 FROM public.followup_case_member_generations WHERE followup_case_id=${pgLiteral(ids.caseId)}::uuid AND generation_id=${pgLiteral(ids.core[1])}::uuid),
      'G3CurrentPresent', EXISTS (SELECT 1 FROM public.followup_case_member_generations WHERE followup_case_id=${pgLiteral(ids.caseId)}::uuid AND generation_id=${pgLiteral(ids.core[2])}::uuid),
      'G4OldPreparingRemoved', NOT EXISTS (SELECT 1 FROM public.followup_case_member_generations WHERE followup_case_id=${pgLiteral(ids.caseId)}::uuid AND generation_id=${pgLiteral(ids.core[3])}::uuid),
      'G5YoungPreparingPresent', EXISTS (SELECT 1 FROM public.followup_case_member_generations WHERE followup_case_id=${pgLiteral(ids.caseId)}::uuid AND generation_id=${pgLiteral(ids.core[4])}::uuid),
      'ActiveRunPresent', EXISTS (SELECT 1 FROM public.followup_case_member_generations WHERE followup_case_id=${pgLiteral(ids.activeCase)}::uuid AND generation_id=${pgLiteral(ids.active[2])}::uuid),
      'PendingRecoveryPresent', EXISTS (SELECT 1 FROM public.followup_case_member_generations WHERE followup_case_id=${pgLiteral(ids.recoveryCase)}::uuid AND generation_id=${pgLiteral(ids.recovery[2])}::uuid),
      'ActivePointer', (SELECT member_generation_id FROM public.followup_cases WHERE id=${pgLiteral(ids.activeCase)}::uuid),
      'RecoveryPointer', (SELECT member_generation_id FROM public.followup_cases WHERE id=${pgLiteral(ids.recoveryCase)}::uuid)
    )::text;
  `));
  check(result.G1Removed && result.G2PreviousPresent && result.G3CurrentPresent && result.G4OldPreparingRemoved && result.G5YoungPreparingPresent, "GENERATION_RETENTION_EXPECTATIONS");
  check(result.ActiveRunPresent && result.PendingRecoveryPresent && result.ActivePointer === ids.active[1] && result.RecoveryPointer === ids.recovery[1], "ACTIVE_AND_PENDING_RECOVERY_PROTECTED");
  report.cleanupDry = true;
  report.cleanupApply = true;
  report.cleanupIdempotent = true;
  report.currentProtected = result.G3CurrentPresent;
  report.previousProtected = result.G2PreviousPresent;
  report.youngPreparingProtected = result.G5YoungPreparingPresent;
  report.oldPreparingRemoved = result.G4OldPreparingRemoved;
  report.activeRunProtected = result.ActiveRunPresent;
  report.pendingRecoveryProtected = result.PendingRecoveryPresent;
}

async function batchAndMemberLimits(report) {
  const rows = [];
  for (let index = 0; index < 6; index += 1) {
    const c = uuid(); const current = uuid(); const old = uuid();
    rows.push({ c, current, old });
  }
  runSql(`
    BEGIN;
    INSERT INTO public.followup_cases(id) VALUES ${rows.map(({ c }) => `(${pgLiteral(c)}::uuid)`).join(",")};
    INSERT INTO public.followup_case_member_generations(followup_case_id,generation_id,expected_member_count,generation_status,created_at,committed_at) VALUES ${rows.map(({ c, current }) => `(${pgLiteral(c)}::uuid,${pgLiteral(current)}::uuid,0,'COMMITTED',now()-interval '1 day',now()-interval '1 day')`).join(",")};
    INSERT INTO public.followup_case_member_generations(followup_case_id,generation_id,expected_member_count,generation_status,created_at,committed_at) VALUES ${rows.map(({ c, old }) => `(${pgLiteral(c)}::uuid,${pgLiteral(old)}::uuid,0,'PREPARING',now()-interval '8 days',NULL)`).join(",")};
    UPDATE public.followup_cases AS fc SET cohort_version=2,member_generation_id=x.current FROM (VALUES ${rows.map(({ c, current }) => `(${pgLiteral(c)}::uuid,${pgLiteral(current)}::uuid)`).join(",")}) AS x(id,current) WHERE fc.id=x.id;
    COMMIT;
  `);
  const dry = await callCleanup(true, 5, 5000);
  check(dry.body.eligibleGenerationsInBatch === 5, "CASE_BATCH_LIMIT_DRY_RUN", String(dry.body.eligibleGenerationsInBatch));
  const apply = await callCleanup(false, 5, 5000);
  check(apply.body.deletedGenerations <= 5 && apply.body.deletedMemberRows <= 5000, "CASE_BATCH_LIMIT", JSON.stringify(apply.body));
  const remaining = Number(psql(`SELECT count(*) FROM public.followup_case_member_generations WHERE generation_status='PREPARING' AND created_at < now()-interval '7 days'`));
  check(remaining >= 1, "CASE_BATCH_LIMIT_LEFT_WORK");
  for (let i = 0; i < 4; i += 1) {
    const next = await callCleanup(false, 5, 5000);
    if (next.body.deletedGenerations === 0) break;
  }
  const limitCase = uuid(); const current = uuid(); const old = uuid();
  await postCase(limitCase);
  await postGeneration(limitCase, current, 0);
  await setGenerationCommitted(limitCase, current, 0);
  await flipPointer(limitCase, current, 0);
  await postGeneration(limitCase, old, 5001, new Date(Date.now() - 8 * 86400000).toISOString());
  const oldRows = await writeMemberRows(limitCase, old, 5001, "LIMIT");
  check(oldRows.maxChunkRows <= 500 && oldRows.maxChunkBytes <= 131072, "MEMBER_FIXTURE_CHUNK_LIMIT");
  const limited = await callCleanup(false, 5, 5000);
  check(limited.body.deletedMemberRows <= 5000, "MEMBER_ROW_LIMIT", JSON.stringify(limited.body));
  const leftAfterFirst = Number(psql(`SELECT count(*) FROM public.followup_case_members WHERE followup_case_id=${pgLiteral(limitCase)}::uuid AND generation_id=${pgLiteral(old)}::uuid`));
  check(leftAfterFirst === 1, "MEMBER_ROW_LIMIT_REMAINDER", String(leftAfterFirst));
  const final = await callCleanup(false, 5, 5000);
  check(final.body.deletedMemberRows === 1 && final.body.deletedGenerations === 1, "MEMBER_ROW_LIMIT_RESUMABLE", JSON.stringify(final.body));
  report.caseBatchLimit = true;
  report.memberRowLimit = true;
}

async function postgrestAnd10k(report) {
  const runtime = await apiRequest("rpc/opspilot_shadow_test_runtime_settings", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const runtimeValue = rpcBody(runtime.body);
  check(runtimeValue.role === "service_role" && typeof runtimeValue.statement_timeout === "string", "POSTGREST_SERVICE_ROLE_RUNTIME", JSON.stringify(runtimeValue));
  report.postgrestTimeout = runtimeValue.statement_timeout;

  const safeCase = uuid(); const current = uuid(); const abandoned = uuid();
  await postCase(safeCase);
  await postGeneration(safeCase, current, 0);
  await setGenerationCommitted(safeCase, current, 0);
  await flipPointer(safeCase, current, 0);
  await postGeneration(safeCase, abandoned, 0, new Date(Date.now() - 8 * 86400000).toISOString());
  const rpcDry = await callCleanup(true, 5, 5000);
  check(rpcDry.body.dryRun === true && Number.isInteger(rpcDry.body.eligibleGenerationsInBatch), "POSTGREST_RPC_DRY_RUN", JSON.stringify(rpcDry.body));
  const rpcApply = await callCleanup(false, 5, 5000);
  check(rpcApply.body.dryRun === false && rpcApply.body.deletedGenerations >= 1, "POSTGREST_RPC_APPLY", JSON.stringify(rpcApply.body));
  check(Number(psql(`SELECT count(*) FROM public.followup_case_member_generations WHERE followup_case_id=${pgLiteral(safeCase)}::uuid AND generation_id=${pgLiteral(current)}::uuid`)) === 1, "POSTGREST_APPLY_CURRENT_PROTECTED");
  check(Number(psql(`SELECT count(*) FROM public.followup_case_member_generations WHERE followup_case_id=${pgLiteral(safeCase)}::uuid AND generation_id=${pgLiteral(abandoned)}::uuid`)) === 0, "POSTGREST_APPLY_OLD_REMOVED");
  report.postgrestRpcDry = true;
  report.postgrestRpcApply = true;

  const caseId = uuid(); const generationId = uuid();
  const parentInsert = await postCase(caseId);
  check(parentInsert.response.status >= 200 && parentInsert.response.status < 300, "POSTGREST_CASE_INSERT", String(parentInsert.response.status));
  const generationInsert = await postGeneration(caseId, generationId, 10000);
  check(generationInsert.response.status >= 200 && generationInsert.response.status < 300, "POSTGREST_GENERATION_INSERT", String(generationInsert.response.status));
  const written = await writeMemberRows(caseId, generationId, 10000, "SHADOW10K");
  report.writeChunks = written.chunks;
  report.maxChunkRows = written.maxChunkRows;
  report.maxChunkBytes = written.maxChunkBytes;
  const keyRead = await readMemberKeys(caseId, generationId, 10000);
  const expectedKeys = Array.from({ length: 10000 }, (_, index) => `SHADOW10K-${String(index).padStart(5, "0")}`);
  check(keyRead.keys.every((key, index) => key === expectedKeys[index]), "POSTGREST_EXACT_KEY_SET");
  const dbCounts = JSON.parse(psql(`
    SELECT jsonb_build_object(
      'rows', count(*), 'distinctKeys', count(DISTINCT order_code),
      'timeout', current_setting('statement_timeout')
    )::text
    FROM public.followup_case_members
    WHERE followup_case_id=${pgLiteral(caseId)}::uuid AND generation_id=${pgLiteral(generationId)}::uuid;
  `));
  check(Number(dbCounts.rows) === 10000 && Number(dbCounts.distinctKeys) === 10000, "DATABASE_COUNT_AND_KEY_SET", JSON.stringify(dbCounts));
  const commitMs = await setGenerationCommitted(caseId, generationId, 10000);
  const pointerMs = await flipPointer(caseId, generationId, 10000);
  const statementDurations = written.durations;
  const sortedDurations = [...statementDurations].sort((a, b) => a - b);
  const p50 = sortedDurations[Math.floor((sortedDurations.length - 1) * 0.50)];
  const p95 = sortedDurations[Math.ceil(sortedDurations.length * 0.95) - 1];
  const max = Math.max(...statementDurations);
  report.writeP50 = p50;
  report.writeP95 = p95;
  report.writeMax = max;
  report.verifyMax = keyRead.maxMs;
  report.pointerMax = pointerMs;
  report.generationCommitMs = commitMs;
  check(written.maxChunkRows <= 500 && written.maxChunkBytes <= 131072, "SHADOW_10K_CHUNK_LIMITS");
  check(p95 < 2000 && max < 4000 && pointerMs < 1000, "SHADOW_10K_PERFORMANCE", `p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms pointer=${pointerMs.toFixed(2)}ms`);
  check(max < 8000 && pointerMs < 8000 && keyRead.maxMs < 8000, "UNDER_8S_STATEMENT_REFERENCE");
  report.postgrestInsert = true;
  report.postgrestRead = true;
  report.shadow10k = true;
  report.httpStatuses = { ...HTTP_STATUS };
}

async function skipLockedGate(report) {
  const caseId = uuid(); const current = uuid(); const abandoned = uuid();
  runSql(`
    INSERT INTO public.followup_cases(id,cohort_version,member_generation_id) VALUES (${pgLiteral(caseId)}::uuid,2,${pgLiteral(current)}::uuid);
    INSERT INTO public.followup_case_member_generations(followup_case_id,generation_id,expected_member_count,generation_status,created_at,committed_at)
    VALUES (${pgLiteral(caseId)}::uuid,${pgLiteral(current)}::uuid,0,'COMMITTED',now(),now()),
           (${pgLiteral(caseId)}::uuid,${pgLiteral(abandoned)}::uuid,0,'PREPARING',now()-interval '8 days',NULL);
  `);
  const { pg } = dbEnvironment();
  const locker = spawn("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-A", "-t"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...pg },
  });
  let stdout = "";
  let stderr = "";
  locker.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  locker.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  locker.stdin.end(`BEGIN;\nSELECT id FROM public.followup_cases WHERE id=${pgLiteral(caseId)}::uuid FOR UPDATE;\n\\echo OPSPILOT_LOCK_READY\nSELECT pg_sleep(5);\nCOMMIT;\n`);
  const lockReadyAt = Date.now();
  while (!stdout.includes("OPSPILOT_LOCK_READY")) {
    if (Date.now() - lockReadyAt > 10_000) {
      locker.kill();
      throw new Error(`GATE_FAILED:SKIP_LOCKED_FIXTURE_LOCK_TIMEOUT:${safeError(stderr)}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const skipped = await callCleanup(false, 5, 5000);
  check(skipped.body.deletedGenerations === 0 && skipped.body.deletedMemberRows === 0, "SKIP_LOCKED_DURING_CONCURRENT_PARENT_LOCK", JSON.stringify(skipped.body));
  const exitCode = await new Promise((resolvePromise, rejectPromise) => {
    locker.once("error", rejectPromise);
    locker.once("close", (code) => resolvePromise(code));
  });
  if (exitCode !== 0) throw new Error(`GATE_FAILED:SKIP_LOCKED_LOCKER_EXIT:${safeError(stderr)}`);
  const afterUnlock = await callCleanup(false, 5, 5000);
  check(afterUnlock.body.deletedGenerations === 1, "SKIP_LOCKED_RESUMES_AFTER_UNLOCK", JSON.stringify(afterUnlock.body));
  report.skipLocked = true;
}

function postTestSchemaCheck() {
  const result = JSON.parse(runSql(`
    DO $$ BEGIN
      IF to_regclass('public.followup_case_members') IS NULL
        OR to_regclass('public.followup_case_member_generations') IS NULL
        OR to_regclass('public.followup_case_cohort_archive') IS NULL
        OR to_regprocedure('public.cleanup_followup_case_member_generations(boolean,integer,integer)') IS NULL THEN
        RAISE EXCEPTION 'MIGRATION_094_OBJECT_MISSING';
      END IF;
      IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.followup_case_members'::regclass)
        OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.followup_case_member_generations'::regclass)
        OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.followup_case_cohort_archive'::regclass)
        OR NOT has_table_privilege('service_role','public.followup_case_members','INSERT')
        OR NOT has_table_privilege('service_role','public.followup_case_members','SELECT')
        OR NOT has_table_privilege('service_role','public.followup_case_member_generations','INSERT')
        OR NOT has_table_privilege('service_role','public.followup_case_member_generations','UPDATE')
        OR NOT has_table_privilege('service_role','public.followup_case_cohort_archive','INSERT')
        OR NOT has_function_privilege('service_role','public.cleanup_followup_case_member_generations(boolean,integer,integer)','EXECUTE')
        OR has_function_privilege('anon','public.cleanup_followup_case_member_generations(boolean,integer,integer)','EXECUTE')
        OR has_function_privilege('authenticated','public.cleanup_followup_case_member_generations(boolean,integer,integer)','EXECUTE') THEN
        RAISE EXCEPTION 'MIGRATION_094_SECURITY_CONTRACT_FAILED';
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_proc AS p
        CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
        WHERE p.oid='public.cleanup_followup_case_member_generations(boolean,integer,integer)'::regprocedure
          AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
      ) THEN RAISE EXCEPTION 'MIGRATION_094_PUBLIC_EXECUTE_NOT_REVOKED'; END IF;
      IF (SELECT count(*) FROM pg_constraint WHERE conrelid='public.followup_case_members'::regclass AND contype='f') <> 3
        OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.followup_case_member_generations'::regclass AND conname='followup_case_member_generations_pkey')
        OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.followup_case_cohort_archive'::regclass AND contype='p') THEN
        RAISE EXCEPTION 'MIGRATION_094_CONSTRAINT_CONTRACT_FAILED';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.cleanup_followup_case_member_generations(boolean,integer,integer)'::regprocedure AND prosecdef AND proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
        RAISE EXCEPTION 'MIGRATION_094_RPC_SECURITY_DEFINITION_FAILED';
      END IF;
    END $$;
    SELECT jsonb_build_object('memberTable',to_regclass('public.followup_case_members')::text,'generationTable',to_regclass('public.followup_case_member_generations')::text,'archiveTable',to_regclass('public.followup_case_cohort_archive')::text,'cleanupRpc',to_regprocedure('public.cleanup_followup_case_member_generations(boolean,integer,integer)')::text)::text;
  `));
  check(Boolean(result.cleanupRpc), "MIGRATION_094_OBJECTS_AND_SECURITY", JSON.stringify(result));
}

async function test() {
  const migrationPath = ensureCandidate();
  const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : null;
  if (!state?.safe || state.projectRef !== TARGET_REF || state.candidate !== TARGET_COMMIT) throw new Error("GATE_FAILED:SAFE_PREFLIGHT_STATE_REQUIRED");
  const report = { targetCommit: TARGET_COMMIT, shadowRef: TARGET_REF, migration: false };
  const started = performance.now();
  runSql(BOOTSTRAP_SQL);
  console.log("MINIMAL_TEST_BOOTSTRAP=PASS");
  const applyStart = performance.now();
  psql("", { file: migrationPath });
  report.migrationMs = performance.now() - applyStart;
  report.migration = true;
  check(true, "MIGRATION_094_LIVE", `${report.migrationMs.toFixed(2)}ms`);
  postTestSchemaCheck();
  runSql(TEST_RUNTIME_FUNCTION_SQL);
  await cleanupSemantics(report);
  await batchAndMemberLimits(report);
  await postgrestAnd10k(report);
  await skipLockedGate(report);
  report.elapsedMs = performance.now() - started;
  report.httpStatuses = { ...HTTP_STATUS };
  const summary = [
    "## OpsPilot Shadow final gate",
    `- Target project: \`${TARGET_REF}\` (Primary \`${PRIMARY_REF}\` rejected)`,
    `- Candidate checkout: \`${TARGET_COMMIT}\``,
    `- Migration 094: PASS (${report.migrationMs.toFixed(2)} ms)`,
    `- Cleanup dry-run/apply/idempotency: PASS / PASS / PASS`,
    `- Current/previous/young-preparing protected; old committed/preparing cleaned: PASS`,
    `- Active sync run and pending recovery generations protected: PASS`,
    `- Case/member limits: PASS (5 cases; 5000 member rows per apply)`,
    `- Concurrent parent lock / SKIP LOCKED: PASS`,
    `- PostgREST insert/read/RPC: PASS`,
    `- 10k fixture: PASS; ${report.writeChunks} chunks; max ${report.maxChunkRows} rows / ${report.maxChunkBytes} bytes`,
    `- Write p50/p95/max: ${report.writeP50.toFixed(2)} / ${report.writeP95.toFixed(2)} / ${report.writeMax.toFixed(2)} ms`,
    `- Key verification max: ${report.verifyMax.toFixed(2)} ms; pointer update: ${report.pointerMax.toFixed(2)} ms`,
    `- PostgREST status counts: \`${JSON.stringify(report.httpStatuses)}\``,
    `- Live service-role statement_timeout: \`${report.postgrestTimeout}\`; direct DB tests constrained to 8s`,
    "- Primary Production, Vercel configuration, cron, and V3 runtime were not modified.",
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  console.log(summary);
}

const RESTORE_SQL = `
BEGIN;
DROP FUNCTION IF EXISTS public.cleanup_followup_case_member_generations(boolean,integer,integer);
DROP FUNCTION IF EXISTS public.opspilot_shadow_test_runtime_settings();
DROP TABLE IF EXISTS public.followup_case_members;
DROP TABLE IF EXISTS public.followup_case_member_generations;
DROP TABLE IF EXISTS public.followup_case_cohort_archive;
ALTER TABLE IF EXISTS public.followup_cases
  DROP CONSTRAINT IF EXISTS followup_cases_cohort_generation_consistency,
  DROP COLUMN IF EXISTS cohort_version,
  DROP COLUMN IF EXISTS member_generation_id;
DROP TABLE IF EXISTS public.checkpoint_recoveries;
DROP TABLE IF EXISTS public.followup_cases;
DROP TABLE IF EXISTS public.sync_runs;
DROP TYPE IF EXISTS public.followup_state_enum;
COMMIT;
NOTIFY pgrst, 'reload schema';
`;

function restore() {
  if (!existsSync(STATE_FILE)) {
    console.log("RESTORE_SKIPPED_NO_SAFE_PREFLIGHT_STATE");
    return;
  }
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  if (!state.safe || state.projectRef !== TARGET_REF || state.candidate !== TARGET_COMMIT) throw new Error("GATE_FAILED:RESTORE_STATE_IDENTITY");
  const migrationPath = ensureCandidate();
  void migrationPath;
  const currentDigest = psql(V3_DIGEST_SQL);
  if (currentDigest !== state.digest) throw new Error("GATE_FAILED:V3_DIGEST_CHANGED_BEFORE_RESTORE; temporary test objects left for owner review");
  runSql(RESTORE_SQL);
  const remaining = JSON.parse(runSql(`
    DO $$ BEGIN
      IF to_regtype('public.followup_state_enum') IS NOT NULL
        OR to_regclass('public.sync_runs') IS NOT NULL
        OR to_regclass('public.followup_cases') IS NOT NULL
        OR to_regclass('public.checkpoint_recoveries') IS NOT NULL
        OR to_regclass('public.followup_case_members') IS NOT NULL
        OR to_regclass('public.followup_case_member_generations') IS NOT NULL
        OR to_regclass('public.followup_case_cohort_archive') IS NOT NULL
        OR to_regprocedure('public.cleanup_followup_case_member_generations(boolean,integer,integer)') IS NOT NULL
        OR to_regprocedure('public.opspilot_shadow_test_runtime_settings()') IS NOT NULL THEN
        RAISE EXCEPTION 'TEMPORARY_OBJECT_REMAINS_AFTER_RESTORE';
      END IF;
    END $$;
    SELECT jsonb_build_object(
      'shadow_sync_runs', (SELECT count(*) FROM public.shadow_sync_runs),
      'order_state_versions', (SELECT count(*) FROM public.order_state_versions),
      'snapshot_v3_shadow_comparisons', (SELECT count(*) FROM public.snapshot_v3_shadow_comparisons),
      'sync_run_order_refs', (SELECT count(*) FROM public.sync_run_order_refs)
    )::text;
  `));
  const afterDigest = psql(V3_DIGEST_SQL);
  check(afterDigest === state.digest, "SHADOW_SCHEMA_MATCH", afterDigest);
  check(Object.values(remaining).every((count) => Number(count) === 0), "SHADOW_ROWS_AFTER_RESTORE", JSON.stringify(remaining));
  unlinkSync(STATE_FILE);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n- Shadow restore: PASS; schema digest \`${afterDigest}\`; application rows all zero.\n`);
}

async function main() {
  try {
    const command = process.argv[2];
    if (command === "preflight") preflight();
    else if (command === "test") await test();
    else if (command === "restore") restore();
    else throw new Error("Usage: opspilot-shadow-final-gate.mjs preflight|test|restore");
  } catch (error) {
    console.error(safeError(error));
    process.exitCode = 1;
  }
}

await main();
