/**
 * Standalone Worker Process for True Cross-Process Durability Testing
 * Runs in its own OS process space with zero memory sharing.
 */

import path from "path";
import { createClient } from "@supabase/supabase-js";
import { loadAndVerifyStagingEnv } from "./staging-safety-guard.mjs";
import { SupabaseCheckpointWorkQueueRepository } from "../src/repositories/supabase/SupabaseCheckpointWorkQueueRepository";
import { SupabaseOrderSnapshotRepository } from "../src/repositories/supabase/SupabaseOrderSnapshotRepository";
import { SupabaseSyncRunRepository } from "../src/repositories/supabase/SupabaseSyncRunRepository";
import { SupabaseIncidentRepository } from "../src/repositories/supabase/SupabaseIncidentRepository";
import { SupabaseIncidentHistoryRepository } from "../src/repositories/supabase/SupabaseIncidentHistoryRepository";
import { SupabaseFollowupRepository } from "../src/repositories/supabase/SupabaseFollowupRepository";
import { PostBarrierShadowHandler } from "../src/engine/checkpoint-v2/post-barrier-handler";
import { CheckpointWorker } from "../src/engine/checkpoint-v2/checkpoint-worker";
import { SupabaseDispatchLedgerStorage } from "../src/engine/checkpoint-v2/dispatch-ledger";
import type { WorkUnitExecutionHandler } from "../src/engine/checkpoint-v2/checkpoint-worker";

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const checkpointAt = getArg("--checkpoint-at");
  const syncRunId = getArg("--sync-run-id");
  const workerId = getArg("--worker-id") || `worker_${process.pid}`;
  const delayMs = parseInt(getArg("--delay-ms") || "0", 10);
  const leaseSeconds = parseInt(getArg("--lease-seconds") || "30", 10);

  if (!checkpointAt || !syncRunId) {
    console.error("Missing required arguments: --checkpoint-at, --sync-run-id");
    process.exit(1);
  }

  const envPath = path.resolve(process.cwd(), ".env.staging.local");
  const env = loadAndVerifyStagingEnv(envPath);

  if (env.projectRef === "elwnbwimgzijuelfjdsq" || env.url.includes("elwnbwimgzijuelfjdsq")) {
    console.error("FATAL: Staging safety guard blocked execution against production!");
    process.exit(1);
  }

  const supabase = createClient(env.url, env.secretKey, {
    auth: { persistSession: false },
  });

  const queueRepo = new SupabaseCheckpointWorkQueueRepository(supabase);
  const postBarrierHandler = new PostBarrierShadowHandler({
    orderSnapshotRepo: new SupabaseOrderSnapshotRepository(supabase),
    syncRunRepo: new SupabaseSyncRunRepository(supabase),
    incidentRepo: new SupabaseIncidentRepository(supabase),
    incidentHistoryRepo: new SupabaseIncidentHistoryRepository(supabase),
    followupRepo: new SupabaseFollowupRepository(supabase),
    dispatchLedgerStorage: new SupabaseDispatchLedgerStorage(supabase),
  });
  const realExecutionHandler = postBarrierHandler.createExecutionHandler();

  const worker = new CheckpointWorker(
    queueRepo,
    {
      softBudgetMs: 120_000,
      safeTailMarginMs: 5_000,
      warningBudgetMs: 130_000,
      criticalBudgetMs: 140_000,
      platformCeilingMs: 150_000,
      leaseDurationMs: leaseSeconds * 1000,
    },
    workerId
  );

  console.log(`[WORKER_START] PID=${process.pid} WORKER_ID=${workerId} LEASE_SEC=${leaseSeconds} DELAY_MS=${delayMs}`);

  const handler: WorkUnitExecutionHandler = async (unit) => {
    console.log(`[UNIT_START] PID=${process.pid} WORKER_ID=${workerId} UNIT_ID=${unit.id} TYPE=${unit.workType} ATTEMPTS=${unit.attempts}`);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const result = await realExecutionHandler(unit, workerId);
    console.log(`[UNIT_FINISH] PID=${process.pid} WORKER_ID=${workerId} UNIT_ID=${unit.id} ITEMS_PROCESSED=${result.itemsProcessed}`);
    return result;
  };

  const summary = await worker.runLoop(checkpointAt, syncRunId, handler, "SHADOW");
  console.log(`[WORKER_EXIT] PID=${process.pid} WORKER_ID=${workerId} UNITS_COMPLETED=${summary.workUnitsCompleted} STAGE=${summary.stageReached}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[WORKER_ERROR] PID=${process.pid} ERROR:`, err);
  process.exit(1);
});
