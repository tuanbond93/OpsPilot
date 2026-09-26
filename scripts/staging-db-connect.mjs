import pg from "pg";
import { loadAndVerifyStagingEnv } from "./staging-safety-guard.mjs";
import path from "path";

async function testConnection() {
  const envPath = path.resolve(process.cwd(), ".env.staging.local");
  const env = loadAndVerifyStagingEnv(envPath);

  // Staging host candidates: direct (port 5432) or pooler (port 6543)
  const directHost = `db.${env.projectRef}.supabase.co`;
  console.log(`Connecting to staging host: ${directHost}...`);

  const client = new pg.Client({
    host: directHost,
    port: 5432,
    user: "postgres",
    password: env.dbPassword,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  try {
    await client.connect();
    console.log("CONNECTED_TO_STAGING: SUCCESS (Direct 5432)");
    const res = await client.query("SELECT version(), current_database(), current_user;");
    console.log("DB_INFO:", res.rows[0].current_database, res.rows[0].current_user);
    await client.end();
    return;
  } catch (err) {
    console.log(`Direct 5432 failed (${err.message}). Trying pooler...`);
  }

  // Pooler fallback: aws-0-ap-southeast-1.pooler.supabase.com or aws-0-us-east-1.pooler.supabase.com
  const regions = [
    "ap-southeast-1",
    "us-east-1",
    "us-west-1",
    "eu-central-1",
    "ap-northeast-1",
  ];

  for (const reg of regions) {
    const poolerHost = `aws-0-${reg}.pooler.supabase.com`;
    const poolerUser = `postgres.${env.projectRef}`;
    const poolerClient = new pg.Client({
      host: poolerHost,
      port: 6543,
      user: poolerUser,
      password: env.dbPassword,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000,
    });

    try {
      await poolerClient.connect();
      console.log(`CONNECTED_TO_STAGING: SUCCESS (Pooler ${poolerHost})`);
      const res = await poolerClient.query("SELECT current_database(), current_user;");
      console.log("DB_INFO:", res.rows[0]);
      await poolerClient.end();
      return;
    } catch {
      // try next region
    }
  }

  console.error("FAILED_TO_CONNECT_TO_STAGING");
  process.exit(1);
}

testConnection();
