import http from "http";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { loadAndVerifyStagingEnv } from "./staging-safety-guard.mjs";
import { SupabaseCheckpointWorkQueueRepository } from "../src/repositories/supabase/SupabaseCheckpointWorkQueueRepository";
import { CheckpointShadowRunner } from "../src/engine/checkpoint-v2/checkpoint-shadow-runner";
import { DEFAULT_WORKER_BUDGET } from "../src/domain/checkpoint-v2/types";
import type { WorkUnitExecutionHandler } from "../src/engine/checkpoint-v2/checkpoint-worker";
import { SupabaseDispatchLedgerStorage, CheckpointDispatchLedger } from "../src/engine/checkpoint-v2/dispatch-ledger";

const envPath = path.resolve(process.cwd(), ".env.staging.local");
const stagingEnv = loadAndVerifyStagingEnv(envPath);

if (stagingEnv.projectRef === "elwnbwimgzijuelfjdsq") {
  console.error("FATAL: Target is production database! Aborting immediately.");
  process.exit(1);
}

// Configure environment for connectors
process.env.NEXT_PUBLIC_SUPABASE_URL = stagingEnv.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = stagingEnv.secretKey;
process.env.CHECKPOINT_PIPELINE_V2_SHADOW = "true";
process.env.CRON_SECRET = "ops-staging-cron-secret-2026";

const supabase = createClient(stagingEnv.url, stagingEnv.secretKey, {
  auth: { persistSession: false },
});
const queueRepo = new SupabaseCheckpointWorkQueueRepository(supabase);
const shadowRunner = new CheckpointShadowRunner(queueRepo);
const ledgerStorage = new SupabaseDispatchLedgerStorage(supabase);
const dispatchLedger = new CheckpointDispatchLedger(ledgerStorage);

export interface WorkerHttpInvocationRecord {
  invocationId: string;
  receivedAt: string;
  method: string;
  url: string;
  authHeaderPresent: boolean;
  authorized: boolean;
  shadowEnabled: boolean;
  httpStatus: number;
  responseBody?: any;
  durationMs: number;
  workerSummary?: any;
}

const telemetry: WorkerHttpInvocationRecord[] = [];

const server = http.createServer(async (req, res) => {
  const reqStart = performance.now();
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = reqUrl.pathname;
  const method = req.method || "GET";

  console.log(`[WORKER_HTTP] ${method} ${pathname} from ${req.socket.remoteAddress}`);

  // Health check
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "GREEN", timestamp: new Date().toISOString() }));
    return;
  }

  // Telemetry endpoint
  if (pathname === "/telemetry") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, count: telemetry.length, invocations: telemetry }));
    return;
  }

  // Admin clear telemetry
  if (pathname === "/admin/clear-telemetry" && method === "POST") {
    telemetry.length = 0;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, cleared: true }));
    return;
  }

  // Admin shadow mode toggle
  if (pathname === "/admin/set-shadow-mode" && method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        if (typeof parsed.enabled === "boolean") {
          process.env.CHECKPOINT_PIPELINE_V2_SHADOW = parsed.enabled ? "true" : "false";
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, shadowEnabled: process.env.CHECKPOINT_PIPELINE_V2_SHADOW }));
      } catch (e: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Worker route handler
  if (pathname === "/api/internal/checkpoint-v2/worker") {
    const cronSecret = (process.env.CRON_SECRET || "").trim();
    const authHeader = (req.headers["authorization"] || "").toString();
    const xCronSecret = (req.headers["x-cron-secret"] || "").toString();
    const isAuthorized =
      cronSecret !== "" && (authHeader === `Bearer ${cronSecret}` || xCronSecret === cronSecret);

    const record: WorkerHttpInvocationRecord = {
      invocationId: crypto.randomUUID(),
      receivedAt: new Date().toISOString(),
      method,
      url: req.url || "",
      authHeaderPresent: Boolean(authHeader || xCronSecret),
      authorized: isAuthorized,
      shadowEnabled: process.env.CHECKPOINT_PIPELINE_V2_SHADOW === "true",
      httpStatus: 200,
      durationMs: 0,
    };

    if (!isAuthorized) {
      record.httpStatus = 401;
      record.responseBody = { error: "Unauthorized", message: "Invalid or missing server-side authorization" };
      record.durationMs = Math.round(performance.now() - reqStart);
      telemetry.push(record);

      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify(record.responseBody));
      return;
    }

    if (process.env.CHECKPOINT_PIPELINE_V2_SHADOW !== "true") {
      record.httpStatus = 200;
      record.responseBody = {
        ok: true,
        status: "SKIPPED",
        reason: "SHADOW_DISABLED",
        message: "Checkpoint Pipeline V2 Shadow mode is currently disabled.",
      };
      record.durationMs = Math.round(performance.now() - reqStart);
      telemetry.push(record);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(record.responseBody));
      return;
    }

    try {
      let checkpointAt = reqUrl.searchParams.get("checkpoint_at");
      let syncRunId = reqUrl.searchParams.get("sync_run_id");

      if (!checkpointAt) {
        const { data: activeUnits, error: queryError } = await supabase
          .from("checkpoint_work_units")
          .select("checkpoint_at, sync_run_id")
          .eq("execution_mode", "SHADOW")
          .in("status", ["PENDING", "LEASED"])
          .order("checkpoint_at", { ascending: true })
          .limit(1);

        if (queryError) {
          throw new Error(`Failed to query active shadow work units: ${queryError.message}`);
        }

        if (!activeUnits || activeUnits.length === 0) {
          record.httpStatus = 200;
          record.responseBody = {
            ok: true,
            status: "IDLE",
            message: "No pending or leased SHADOW work units found.",
            unitsClaimed: 0,
            unitsCompleted: 0,
          };
          record.durationMs = Math.round(performance.now() - reqStart);
          telemetry.push(record);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(record.responseBody));
          return;
        }

        checkpointAt = activeUnits[0].checkpoint_at;
        syncRunId = activeUnits[0].sync_run_id;
      }

      const finalCheckpointAt: string = checkpointAt!;
      let targetSyncRunId: string = syncRunId || "";
      if (!targetSyncRunId) {
        const { data: runData } = await supabase
          .from("checkpoint_work_units")
          .select("sync_run_id")
          .eq("checkpoint_at", finalCheckpointAt)
          .limit(1);
        targetSyncRunId = runData?.[0]?.sync_run_id || "unknown";
      }

      console.log(`[WORKER_HTTP] Executing batch for checkpoint ${finalCheckpointAt} (${targetSyncRunId})...`);
      const softBudgetParam = Number(reqUrl.searchParams.get("soft_budget_ms"));
      const safeTailParam = Number(reqUrl.searchParams.get("safe_tail_margin_ms"));
      const budgetConfig = {
        ...DEFAULT_WORKER_BUDGET,
        softBudgetMs: softBudgetParam > 0 ? softBudgetParam : 38_000,
        safeTailMarginMs: safeTailParam > 0 ? safeTailParam : 8_000,
      };

      const customHandler: WorkUnitExecutionHandler = async (unit) => {
        switch (unit.workType) {
          case "INGEST_POPULATION_CHUNK": {
            return { itemsProcessed: unit.cursor.limit };
          }
          case "EVALUATE_INCIDENTS_CHUNK": {
            return { itemsProcessed: unit.cursor.limit };
          }
          case "EVALUATE_FOLLOWUP_BATCH": {
            return { itemsProcessed: unit.cursor.limit };
          }
          case "PERSIST_MEMBERS_CHUNK": {
            if (unit.cursor.metadata?.kind === "GENERATION_COMMIT") {
              const caseIds = (unit.cursor.metadata?.caseIds as string[]) || [];
              if (caseIds.length > 0) {
                const { error: genErr } = await supabase
                  .from("followup_case_member_generations")
                  .update({
                    generation_status: "COMMITTED",
                    committed_at: new Date().toISOString(),
                  })
                  .eq("generation_id", unit.syncRunId)
                  .in("followup_case_id", caseIds);
                if (genErr) throw new Error(`Generation commit failed: ${genErr.message}`);
              }
              return { itemsProcessed: unit.cursor.limit };
            } else {
              const offset = unit.cursor.offset;
              const limit = unit.cursor.limit;
              const caseIds = (unit.cursor.metadata?.caseIds as string[]) || [];
              const defaultCaseId = (unit.cursor.metadata?.caseId as string) || `case_${unit.syncRunId.slice(0, 8)}_0`;
              const rows = [];
              for (let m = 0; m < limit; m++) {
                const mIdx = offset + m;
                const cId = caseIds.length > 0 ? caseIds[m % caseIds.length] : defaultCaseId;
                rows.push({
                  followup_case_id: cId,
                  generation_id: unit.syncRunId,
                  source_sync_run_id: unit.syncRunId,
                  order_code: `ORD_${unit.syncRunId.slice(0, 6)}_${mIdx}`,
                  customer_id: "CUST_PRODUCTION",
                  warehouse_id: "WH_HNI_01",
                  stage: "DELIVERY",
                  status: m % 2 === 0 ? "delivering" : "delay",
                  baseline_status: "delivering",
                  is_baseline: true,
                  member_active: true,
                  observed_at: unit.checkpointAt,
                  due_at: unit.checkpointAt,
                });
              }
              const { error: memberErr } = await supabase
                .from("followup_case_members")
                .upsert(rows, { onConflict: "followup_case_id,generation_id,order_code" });
              if (memberErr) throw new Error(`Member upsert failed: ${memberErr.message}`);
              return { itemsProcessed: limit };
            }
          }
          case "DISPATCH_INTERVENTION_BATCH": {
            const caseId = (unit.cursor.metadata?.caseId as string) || `case_${unit.syncRunId.slice(0, 8)}_${unit.cursor.offset}`;
            await dispatchLedger.dispatchEffectivelyOnce({
              checkpointAt: unit.checkpointAt,
              syncRunId: unit.syncRunId,
              caseId,
              incidentKey: `WH_HNI_01:KHO_TON:SHADOW_${unit.partitionKey}`,
              interventionType: (unit.cursor.metadata?.interventionType as string) || "TELEGRAM_FIRST_PUSH",
              executionMode: "SHADOW",
              sendExternal: async () => {
                throw new Error("SECURITY_BREACH: sendExternal must never be invoked in SHADOW mode!");
              },
            });
            return { itemsProcessed: unit.cursor.limit };
          }
          default:
            return { itemsProcessed: unit.cursor.limit };
        }
      };

      const summary = await shadowRunner.runWorkerBatch(
        finalCheckpointAt,
        targetSyncRunId,
        budgetConfig,
        customHandler
      );

      record.httpStatus = 200;
      record.workerSummary = summary;
      record.responseBody = {
        ok: true,
        status: "SUCCESS",
        checkpointAt: finalCheckpointAt,
        syncRunId: targetSyncRunId,
        summary,
      };
      record.durationMs = Math.round(performance.now() - reqStart);
      telemetry.push(record);

      console.log(
        `[WORKER_HTTP] Batch completed in ${record.durationMs}ms: claimed=${summary.workUnitsClaimed}, completed=${summary.workUnitsCompleted}, yielded=${summary.softBudgetYielded}`
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(record.responseBody));
      return;
    } catch (err: any) {
      console.error("[WORKER_HTTP_ERROR]:", err.message);
      record.httpStatus = 500;
      record.responseBody = { ok: false, error: err.message };
      record.durationMs = Math.round(performance.now() - reqStart);
      telemetry.push(record);

      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify(record.responseBody));
      return;
    }
  }

  // Fallback 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

const PORT = 3005;
server.listen(PORT, "127.0.0.1", () => {
  console.log(`STAGING_WORKER_SERVER_STARTED: http://127.0.0.1:${PORT}`);
  console.log(`Target: Staging Supabase (${stagingEnv.projectRef})`);
  console.log(`Shadow Mode: ${process.env.CHECKPOINT_PIPELINE_V2_SHADOW}`);
});
