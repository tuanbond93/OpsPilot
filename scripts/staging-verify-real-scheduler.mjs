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

  const cronRes = await client.query(`
    SELECT runid, jobid, database, username, command, status, return_message, start_time, end_time
    FROM cron.job_run_details
    WHERE jobid = 3
    ORDER BY start_time DESC
    LIMIT 3;
  `);
  console.log("CRON_JOB_DETAILS:", cronRes.rows);

  const netRes = await client.query(`
    SELECT id, status_code, content_type, timed_out, error_msg, created
    FROM net._http_response
    ORDER BY created DESC
    LIMIT 3;
  `);
  console.log("NET_HTTP_RESPONSES:", netRes.rows);

  const unitsRes = await client.query(`
    SELECT checkpoint_at, sync_run_id, status, execution_mode, count(*)
    FROM public.checkpoint_work_units
    WHERE execution_mode = 'SHADOW'
    GROUP BY checkpoint_at, sync_run_id, status, execution_mode;
  `);
  console.log("SHADOW_WORK_UNITS_IN_DB:", unitsRes.rows);

  await client.end();
}

main().catch(console.error);
