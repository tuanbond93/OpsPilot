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

  console.log("Connected to staging.");
  const reqId = await client.query("SELECT net.http_post(url := 'https://postman-echo.com/post', body := '{\"test\": true}'::jsonb);");
  console.log("PG_NET_REQ_ID:", reqId.rows[0]);

  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await client.query("SELECT * FROM net._http_response ORDER BY created DESC LIMIT 2;");
    if (res.rows.length > 0) {
      console.log("HTTP_RESPONSES:", res.rows);
      break;
    }
  }

  await client.end();
}

main().catch(console.error);
