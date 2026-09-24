import { createClient } from "@supabase/supabase-js";
import { runFollowupCohortRollbackBatch } from "@/services/followup-cohort-rollback";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error("Supabase operator credentials are required.");
  const apply = process.argv.includes("--apply");
  if (apply && !process.argv.includes("--confirm-job14-off")) {
    throw new Error("Rollback apply requires --confirm-job14-off after the operator verifies cron job 14 is OFF.");
  }
  const afterIndex = process.argv.indexOf("--after-id");
  const afterId = afterIndex >= 0 ? process.argv[afterIndex + 1] : null;
  if (afterIndex >= 0 && !afterId) throw new Error("--after-id requires a followup_case UUID cursor.");
  const client = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const result = await runFollowupCohortRollbackBatch(client, { apply, afterId, limit: 5 });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`FOLLOWUP_COHORT_ROLLBACK_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
