import { createClient } from "@supabase/supabase-js";
import { loadAndVerifyStagingEnv } from "./staging-safety-guard.mjs";
import path from "path";

async function testPostgrestClient() {
  const envPath = path.resolve(process.cwd(), ".env.staging.local");
  const env = loadAndVerifyStagingEnv(envPath);

  console.log(`Connecting to PostgREST at ${env.host}...`);

  const supabase = createClient(env.url, env.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: tables, error: err1 } = await supabase
    .from("checkpoint_work_units")
    .select("id")
    .limit(1);

  if (err1) {
    console.error("PostgREST select error:", err1);
    process.exit(1);
  }
  console.log("PostgREST query to checkpoint_work_units: OK, count =", tables.length);

  const { data: rpcData, error: err2 } = await supabase.rpc("claim_checkpoint_work_units", {
    p_checkpoint_at: new Date().toISOString(),
    p_worker_id: "test-worker",
    p_lease_seconds: 60,
    p_limit: 5,
  });

  if (err2) {
    console.error("PostgREST RPC error:", err2);
    process.exit(1);
  }
  console.log("PostgREST RPC claim_checkpoint_work_units: OK, claimed =", Array.isArray(rpcData) ? rpcData.length : rpcData);

  const { data: ledger, error: err3 } = await supabase
    .from("checkpoint_dispatch_ledger")
    .select("id")
    .limit(1);

  if (err3) {
    console.error("PostgREST select error on dispatch ledger:", err3);
    process.exit(1);
  }
  console.log("PostgREST query to checkpoint_dispatch_ledger: OK");
}

testPostgrestClient().catch(err => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
