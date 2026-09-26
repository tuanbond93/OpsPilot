import pg from "pg";
import path from "path";
import { loadAndVerifyStagingEnv } from "./staging-safety-guard.mjs";

async function verifyStagingSchemaGate() {
  const envPath = path.resolve(process.cwd(), ".env.staging.local");
  const env = loadAndVerifyStagingEnv(envPath);

  const client = new pg.Client({
    host: "aws-0-ap-southeast-1.pooler.supabase.com",
    port: 6543,
    user: `postgres.${env.projectRef}`,
    password: env.dbPassword,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  await client.connect();

  const requiredTables = [
    "sync_runs",
    "inbound_order_observations",
    "inbound_population_manifests",
    "order_snapshots",
    "incidents",
    "followup_cases",
    "followup_events",
    "followup_case_members",
    "followup_case_member_generations",
    "checkpoint_work_units",
    "checkpoint_dispatch_ledger",
  ];

  const requiredRpcs = [
    "claim_checkpoint_work_units",
    "clear_inbound_order_observation_population",
  ];

  // 1. Check tables
  const tablesRes = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
  `);
  const existingTables = new Set(tablesRes.rows.map(r => r.table_name));

  const missingTables = requiredTables.filter(t => !existingTables.has(t));

  // 2. Check RPCs
  const rpcRes = await client.query(`
    SELECT routine_name
    FROM information_schema.routines
    WHERE routine_schema = 'public'
  `);
  const existingRpcs = new Set(rpcRes.rows.map(r => r.routine_name));
  const missingRpcs = requiredRpcs.filter(r => !existingRpcs.has(r));

  // 3. Check latest migration
  const migRes = await client.query(`
    SELECT version, applied_at
    FROM public._schema_migrations
    ORDER BY version DESC
    LIMIT 1;
  `);
  const latestMigration = migRes.rows[0]?.version || "NONE";

  console.log("PRODUCTION_TARGET_GUARD: PASS");
  console.log(`STAGING_PROJECT_REF: ${env.projectRef}`);
  console.log(`LATEST_MIGRATION: ${latestMigration}`);
  console.log(`REQUIRED_TABLES_PRESENT: ${missingTables.length === 0 ? "YES" : "MISSING: " + missingTables.join(", ")}`);
  console.log(`REQUIRED_RPCS_PRESENT: ${missingRpcs.length === 0 ? "YES" : "MISSING: " + missingRpcs.join(", ")}`);
  
  const passed = missingTables.length === 0 && missingRpcs.length === 0;
  console.log(`STAGING_SCHEMA_STATUS: ${passed ? "PASS" : "FAIL"}`);

  await client.end();
  if (!passed) process.exit(1);
}

verifyStagingSchemaGate().catch(err => {
  console.error("GATE_ERROR:", err.message);
  process.exit(1);
});
