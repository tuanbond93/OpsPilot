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

  const cycleUrl = "https://helping-decorative-mud-encouraged.trycloudflare.com/api/cron/followup-cycle";
  const cronSecret = "ops-staging-cron-secret-2026";

  console.log("Configuring Supabase Vault on Staging...");

  // Remove existing secrets if any
  await client.query("DELETE FROM vault.secrets WHERE name IN ('opspilot_followup_cycle_url', 'opspilot_cron_secret');");

  // Create secrets
  await client.query("SELECT vault.create_secret($1, 'opspilot_followup_cycle_url', 'OpsPilot cycle URL for staging testing');", [cycleUrl]);
  await client.query("SELECT vault.create_secret($1, 'opspilot_cron_secret', 'OpsPilot cron secret for staging testing');", [cronSecret]);

  // Verify decrypted secrets
  const res = await client.query("SELECT name, (decrypted_secret IS NOT NULL) AS has_value FROM vault.decrypted_secrets WHERE name IN ('opspilot_followup_cycle_url', 'opspilot_cron_secret');");
  console.log("VAULT_SECRETS_CONFIGURED:", res.rows);

  await client.end();
}

main().catch(console.error);
