import pg from "pg";
import path from "path";
import { loadAndVerifyStagingEnv } from "./staging-safety-guard.mjs";

async function check() {
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

  const fks = await client.query(`
    SELECT
      tc.table_name, kcu.column_name,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_name IN ('followup_cases', 'followup_case_members', 'followup_case_member_generations');
  `);
  console.log("FOREIGN_KEYS:", fks.rows);

  const cols = await client.query(`
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name IN ('followup_cases', 'followup_case_members', 'followup_case_member_generations')
    ORDER BY table_name, ordinal_position;
  `);
  console.log("COLUMNS:", cols.rows);

  const uq = await client.query(`
    SELECT tc.constraint_name, tc.table_name, kcu.column_name, tc.constraint_type
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    WHERE tc.table_name IN ('followup_case_member_generations', 'followup_case_members')
      AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE');
  `);
  console.log("CONSTRAINTS:", uq.rows);

  await client.end();
}
check().catch(console.error);
