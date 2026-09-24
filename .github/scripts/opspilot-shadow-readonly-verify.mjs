import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const SHADOW_REF = process.env.SHADOW_PROJECT_REF;
const PRIMARY_REF = process.env.PRIMARY_PROJECT_REF;
const EXPECTED_DIGEST = process.env.EXPECTED_PRETEST_DIGEST;
const V3_TABLES = [
  "order_state_versions",
  "shadow_sync_runs",
  "snapshot_v3_shadow_comparisons",
  "sync_run_order_refs",
];

function fail(code, detail = "") {
  throw new Error(`${code}${detail ? `: ${detail}` : ""}`);
}

function check(condition, code, detail = "") {
  if (!condition) fail(code, detail);
  console.log(`${code}=PASS${detail ? ` (${detail})` : ""}`);
}

function jwtClaims(token) {
  const pieces = token.split(".");
  if (pieces.length !== 3) fail("SERVICE_ROLE_KEY_IDENTITY", "unverifiable");
  try {
    return JSON.parse(Buffer.from(pieces[1], "base64url").toString("utf8"));
  } catch {
    fail("SERVICE_ROLE_KEY_IDENTITY", "unverifiable");
  }
}

function verifyTarget() {
  if (!SHADOW_REF || !PRIMARY_REF || SHADOW_REF === PRIMARY_REF) {
    fail("PROJECT_REFS_AMBIGUOUS");
  }
  if (SHADOW_REF !== "qkrpbompjwxfpicjfoub" || PRIMARY_REF !== "elwnbwimgzijuelfjdsq") {
    fail("PROJECT_REFS_UNEXPECTED");
  }

  const apiUrl = new URL(process.env.SHADOW_SUPABASE_URL || "");
  if (apiUrl.protocol !== "https:" || apiUrl.hostname !== `${SHADOW_REF}.supabase.co`) {
    fail("SHADOW_API_URL_IDENTITY", "does not resolve to the expected Shadow project");
  }

  const claims = jwtClaims(process.env.SHADOW_SERVICE_ROLE_KEY || "");
  if (claims.ref !== SHADOW_REF || claims.role !== "service_role") {
    fail("SERVICE_ROLE_KEY_IDENTITY", "does not match the expected Shadow project");
  }

  const dbUrl = new URL(process.env.SHADOW_DATABASE_URL || "");
  const username = decodeURIComponent(dbUrl.username).toLowerCase();
  const host = dbUrl.hostname.toLowerCase();
  const directMatch = host === `db.${SHADOW_REF}.supabase.co`;
  const poolerMatch = host.endsWith(".pooler.supabase.com") && username.includes(SHADOW_REF);
  if (dbUrl.protocol !== "postgresql:" && dbUrl.protocol !== "postgres:") {
    fail("SHADOW_DATABASE_URL_IDENTITY", "unsupported database URL scheme");
  }
  if (!directMatch && !poolerMatch) {
    fail("SHADOW_DATABASE_URL_IDENTITY", "database endpoint cannot be tied unambiguously to Shadow");
  }
  console.log(`SHADOW_IDENTITY_CHECK=PASS (${SHADOW_REF}; Primary ${PRIMARY_REF} rejected)`);
  return dbUrl.toString();
}

function psqlOutput(databaseUrl, sql, label) {
  const result = spawnSync("psql", [
    "-X", "--set=ON_ERROR_STOP=1", "--no-align", "--tuples-only", "--quiet",
    "--dbname", databaseUrl,
    "--command", sql,
  ], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      PGSSLMODE: "require",
      PGCONNECT_TIMEOUT: "15",
      PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=8s",
    },
  });

  if (result.error || result.status !== 0) {
    const stderr = String(result.stderr || result.error?.message || "psql failed")
      .replaceAll(databaseUrl, "[redacted database URL]")
      .trim();
    fail(`${label}_QUERY_FAILED`, stderr.slice(-1200));
  }

  const lines = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) fail(`${label}_OUTPUT_SHAPE`, `expected one row; received ${lines.length}`);
  return lines[0];
}

function psqlSelect(databaseUrl, sql, label) {
  const output = psqlOutput(databaseUrl, sql, label);
  try {
    return JSON.parse(output);
  } catch {
    fail(`${label}_JSON_PARSE`, "the separate SELECT did not return one JSON value");
  }
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
) AS digest
`;

const INVENTORY_SQL = `
WITH expected(name) AS (
  VALUES ('order_state_versions'), ('shadow_sync_runs'),
         ('snapshot_v3_shadow_comparisons'), ('sync_run_order_refs')
), public_tables AS (
  SELECT coalesce(jsonb_agg(tablename ORDER BY tablename), '[]'::jsonb) AS names
  FROM pg_tables WHERE schemaname = 'public'
), v3_table_names AS (
  SELECT coalesce(jsonb_agg(name ORDER BY name), '[]'::jsonb) AS names
  FROM expected e WHERE to_regclass(format('public.%I', e.name)) IS NOT NULL
), leftover_relations AS (
  SELECT coalesce(jsonb_agg(c.relname ORDER BY c.relname), '[]'::jsonb) AS names
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND (c.relname IN (
      'followup_case_members', 'followup_case_member_generations',
      'followup_case_cohort_archive', 'followup_cases', 'sync_runs',
      'checkpoint_recoveries'
    ) OR c.relname LIKE 'opspilot_shadow_test_%')
), leftover_types AS (
  SELECT coalesce(jsonb_agg(t.typname ORDER BY t.typname), '[]'::jsonb) AS names
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typname = 'followup_state_enum'
), leftover_functions AS (
  SELECT coalesce(jsonb_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' ORDER BY p.proname), '[]'::jsonb) AS names
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND (
    p.proname = 'cleanup_followup_case_member_generations'
    OR p.proname = 'opspilot_shadow_test_runtime_settings'
    OR p.proname LIKE 'opspilot_shadow_test_%'
  )
)
SELECT jsonb_build_object(
  'publicTables', (SELECT names FROM public_tables),
  'v3TablesPresent', (SELECT names FROM v3_table_names),
  'telemetryFunctionPresent', to_regprocedure('public.snapshot_v3_storage_telemetry()') IS NOT NULL,
  'leftoverRelations', (SELECT names FROM leftover_relations),
  'leftoverTypes', (SELECT names FROM leftover_types),
  'leftoverFunctions', (SELECT names FROM leftover_functions)
)::text
`;

const V3_COUNTS_SQL = `
SELECT jsonb_build_object(
  'order_state_versions', (SELECT count(*) FROM public.order_state_versions),
  'shadow_sync_runs', (SELECT count(*) FROM public.shadow_sync_runs),
  'snapshot_v3_shadow_comparisons', (SELECT count(*) FROM public.snapshot_v3_shadow_comparisons),
  'sync_run_order_refs', (SELECT count(*) FROM public.sync_run_order_refs)
)::text
`;

function main() {
  const databaseUrl = verifyTarget();
  const inventory = psqlSelect(databaseUrl, INVENTORY_SQL, "SHADOW_INVENTORY");
  const expectedTables = [...V3_TABLES].sort();
  const publicTables = [...inventory.publicTables].sort();
  const presentV3Tables = [...inventory.v3TablesPresent].sort();
  const extras = publicTables.filter((name) => !expectedTables.includes(name));
  const missing = expectedTables.filter((name) => !presentV3Tables.includes(name));
  const counts = missing.length === 0 ? psqlSelect(databaseUrl, V3_COUNTS_SQL, "V3_ROW_COUNTS") : null;
  const digest = psqlOutput(databaseUrl, V3_DIGEST_SQL, "V3_SCHEMA_DIGEST");

  const leftovers = [
    ...inventory.leftoverRelations,
    ...inventory.leftoverTypes,
    ...inventory.leftoverFunctions,
  ];
  const digestMatches = digest === EXPECTED_DIGEST;
  const tablesMatch = JSON.stringify(publicTables) === JSON.stringify(expectedTables);
  const v3TablesMatch = JSON.stringify(presentV3Tables) === JSON.stringify(expectedTables);
  const allEmpty = counts !== null && Object.values(counts).every((count) => Number(count) === 0);
  const clean = tablesMatch && v3TablesMatch && inventory.telemetryFunctionPresent
    && leftovers.length === 0 && allEmpty && digestMatches;

  console.log(`V3_PUBLIC_TABLES=${JSON.stringify(publicTables)}`);
  console.log(`V3_TABLE_ROWS=${counts === null ? "UNAVAILABLE" : JSON.stringify(counts)}`);
  console.log(`V3_TELEMETRY_FUNCTION=${inventory.telemetryFunctionPresent ? "PRESENT" : "MISSING"}`);
  console.log(`LEFTOVER_TEST_OBJECTS=${JSON.stringify(leftovers)}`);
  console.log(`PRETEST_SCHEMA_DIGEST=${EXPECTED_DIGEST}`);
  console.log(`CURRENT_SCHEMA_DIGEST=${digest}`);
  check(tablesMatch && v3TablesMatch, "SHADOW_SCHEMA_OBJECTS", `missing=${JSON.stringify(missing)} extra=${JSON.stringify(extras)}`);
  check(inventory.telemetryFunctionPresent, "SHADOW_TELEMETRY_FUNCTION");
  check(leftovers.length === 0, "SHADOW_TEMP_OBJECTS_ABSENT", JSON.stringify(leftovers));
  check(allEmpty, "SHADOW_V3_TABLES_EMPTY", JSON.stringify(counts));
  check(digestMatches, "SHADOW_PRETEST_SCHEMA_DIGEST_MATCH", digest);
  check(clean, "SHADOW_PRE_RERUN_CLEAN");

  const summary = [
    "## Shadow read-only pre-rerun verification",
    `- Project ref: \`${SHADOW_REF}\` (Primary \`${PRIMARY_REF}\` rejected)`,
    `- Public tables: \`${JSON.stringify(publicTables)}\``,
    `- V3 rows: \`${JSON.stringify(counts)}\``,
    `- Leftover temporary objects: \`${JSON.stringify(leftovers)}\``,
    `- Schema digest: \`${digest}\` (expected \`${EXPECTED_DIGEST}\`)`,
    `- Clean: **${clean ? "YES" : "NO"}**`,
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  if (!clean) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(String(error?.message || error).replaceAll(process.env.SHADOW_DATABASE_URL || "", "[redacted database URL]"));
  process.exitCode = 1;
}
