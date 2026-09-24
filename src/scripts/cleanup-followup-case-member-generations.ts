import { createClient } from "@supabase/supabase-js";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error("Supabase operator credentials are required.");
  const apply = process.argv.includes("--apply");
  if (apply && !process.argv.includes("--confirm-job14-off")) {
    throw new Error("Cleanup apply requires --confirm-job14-off after the operator verifies cron job 14 is OFF.");
  }
  const client = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await client.rpc("cleanup_followup_case_member_generations", {
    p_dry_run: !apply,
    p_case_limit: 5,
    p_member_delete_limit: 5000,
  });
  if (error) throw error;
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`FOLLOWUP_MEMBER_GENERATION_CLEANUP_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
