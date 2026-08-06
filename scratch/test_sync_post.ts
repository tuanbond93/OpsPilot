const originalEnv = process.env.NODE_ENV;
(process.env as any).NODE_ENV = 'development';

import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd(), true);

import { POST } from "../src/app/api/debug/sync/route";
import { createAdminClient } from "../src/connectors/supabase";

async function run() {
  console.log("Triggering POST /api/debug/sync...");
  const fakeRequest = new Request("http://localhost/api/debug/sync", { method: "POST" });
  
  try {
    const res = await POST(fakeRequest as any);
    const body = await res.json();
    console.log("Response status:", res.status);
    console.log("Response body:", JSON.stringify(body, null, 2));

    if (body.ok) {
      console.log("Sync succeeded. Querying Supabase for the Sync Run...");
      const client = createAdminClient();
      const { data, error } = await client
        .from("sync_runs")
        .select("*")
        .eq("id", body.syncRunId)
        .single();

      if (error) {
        console.error("Failed to query sync run row:", error);
      } else {
        console.log("Queried sync run row from database:");
        console.log(data);
      }
    }
  } catch (err) {
    console.error("Execution error:", err);
  } finally {
    (process.env as any).NODE_ENV = originalEnv;
  }
}

run();
