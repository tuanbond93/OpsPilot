import pg from "pg";
import path from "path";
import { loadAndVerifyStagingEnv } from "./staging-safety-guard.mjs";

async function main() {
  const env = loadAndVerifyStagingEnv(path.resolve(".env.staging.local"));
  const client = new pg.Client({
    host: "aws-0-ap-southeast-1.pooler.supabase.com",
    port: 6543,
    user: "postgres." + env.projectRef,
    password: env.dbPassword,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const cols = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'vault' AND table_name = 'secrets';");
  console.log("VAULT_COLS:", cols.rows);

  const procs = await client.query("SELECT proname, proargnames FROM pg_proc JOIN pg_namespace ON pg_proc.pronamespace = pg_namespace.oid WHERE nspname = 'vault';");
  console.log("VAULT_PROCS:", procs.rows);

  await client.end();
}

main().catch(console.error);
