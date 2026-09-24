import { createClient } from "@supabase/supabase-js";
import { runFollowupCohortBackfillBatch } from "@/services/followup-cohort-backfill";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in the operator environment.");
  }
  const apply = process.argv.includes("--apply");
  const job14OffConfirmed = process.argv.includes("--confirm-job14-off");
  if (apply && !job14OffConfirmed) {
    throw new Error("Backfill apply requires --confirm-job14-off after the operator verifies cron job 14 is OFF.");
  }
  const afterIndex = process.argv.indexOf("--after-id");
  const afterId = afterIndex >= 0 ? process.argv[afterIndex + 1] : null;
  if (afterIndex >= 0 && !afterId) throw new Error("--after-id requires a UUID cursor.");

  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const result = await runFollowupCohortBackfillBatch(client, {
    apply,
    afterId,
    limit: 5,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`FOLLOWUP_COHORT_BACKFILL_FAILED: ${message}\n`);
  process.exitCode = 1;
});
