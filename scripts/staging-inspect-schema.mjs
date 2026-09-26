import pg from "pg";
import { loadAndVerifyStagingEnv } from "./staging-safety-guard.mjs";
import path from "path";

async function inspectSchema() {
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

  const tablesRes = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name;
  `);

  console.log("EXISTING_TABLES_COUNT:", tablesRes.rows.length);
  console.log("EXISTING_TABLES:", tablesRes.rows.map(r => r.table_name));

  const rpcRes = await client.query(`
    SELECT routine_name
    FROM information_schema.routines
    WHERE routine_schema = 'public'
    ORDER BY routine_name;
  `);
  console.log("EXISTING_RPCS:", rpcRes.rows.map(r => r.routine_name));

  await client.end();
}

inspectSchema().catch(err => {
  console.error("INSPECT_ERROR:", err.message);
  process.exit(1);
});
