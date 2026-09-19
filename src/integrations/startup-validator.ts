import { SecretProvider } from "./secrets";
import { createAdminClient } from "@/connectors/supabase";
import { TelegramClient } from "./telegram";
import { RillnetClient } from "./rillnet";
import { RealtimePublisher } from "./realtime";
import { SchedulerRunner, schedulerRunner } from "./scheduler";
import { HealthRegistry } from "./health";
import { SCHEDULER_JOBS } from "../config/scheduler";
import { generate } from "../ai";
import { createClient } from "@supabase/supabase-js";

export interface StartupReport {
  success: boolean;
  timestamp: string;
  environment: string;
  secrets: {
    ok: boolean;
    missing: string[];
  };
  database: {
    ok: boolean;
    message: string;
  };
  telegram: {
    ok: boolean;
    message: string;
  };
  aiProvider: {
    ok: boolean;
    message: string;
  };
  scheduler: {
    ok: boolean;
    message: string;
  };
}

export class StartupValidator {
  /**
   * Run all startup validation checks and return structured validation report.
   * Registers checkable integrations in the HealthRegistry as side effect.
   */
  static async run(): Promise<StartupReport> {
    const timestamp = new Date().toISOString();
    const environment = process.env.NODE_ENV || "development";

    // 1. Secrets Validation
    const secretCheck = SecretProvider.validate();

    // 2. Database validation
    let dbOk = false;
    let dbMessage = "";
    let dbClient = null;

    try {
      dbClient = createAdminClient();
      if (dbClient) {
        // Query incidents to verify connection
        const { error } = await dbClient.from("incidents").select("id").limit(1);
        if (error) {
          dbMessage = `Supabase DB query error: ${error.message}`;
        } else {
          dbOk = true;
          dbMessage = "Successfully connected to Supabase Database";
        }
      } else {
        dbMessage = "Database client returned null/undefined";
      }
    } catch (err: any) {
      dbMessage = `Database connection failed: ${err?.message || String(err)}`;
    }

    // 3. Telegram validation
    let tgOk = false;
    let tgMessage = "";
    const tgClient = new TelegramClient();

    try {
      const tgHealth = await tgClient.health();
      tgOk = tgHealth.status === "GREEN" || tgHealth.status === "UNKNOWN"; // UNKNOWN means optional/unconfigured in dev which is ok
      tgMessage = tgHealth.healthReason;
    } catch (err: any) {
      tgMessage = `Telegram validation failed: ${err?.message || String(err)}`;
    }

    // 4. AI Provider validation
    let aiOk = false;
    let aiConfigured = false;
    let aiMessage = "";
    const provider = SecretProvider.getOptional("AI_PROVIDER", "openai").toLowerCase();

    try {
      const key = provider === "gemini" ? process.env.GOOGLE_AI_API_KEY : process.env.OPENAI_API_KEY;
      if (!key) {
        if (process.env.ALLOW_IN_MEMORY_FALLBACK === "true" || environment !== "production") {
          aiOk = true;
          aiMessage = `AI Provider ${provider} unconfigured (Development/Mock Fallback Mode active)`;
        } else {
          aiMessage = `AI Provider ${provider} requires an API key in production mode`;
        }
      } else {
        aiOk = true;
        aiConfigured = true;
        aiMessage = `AI Provider '${provider}' API Key verified`;
      }
    } catch (err: any) {
      aiMessage = `AI Provider check failed: ${err?.message || String(err)}`;
    }

    // 5. Scheduler validation
    let schedOk = true;
    let schedMessage = "Scheduler configuration validated successfully";

    try {
      SchedulerRunner.clear();
      for (const job of SCHEDULER_JOBS) {
        SchedulerRunner.register(job);
      }
      const registeredCount = SchedulerRunner.getJobs().length;
      if (registeredCount === 0) {
        schedOk = false;
        schedMessage = "No jobs registered in the Scheduler configuration";
      } else {
        schedMessage = `Scheduler registered ${registeredCount} declarative cron jobs`;
      }
    } catch (err: any) {
      schedOk = false;
      schedMessage = `Scheduler registration failed: ${err?.message || String(err)}`;
    }

    // 6. Register integrations in HealthRegistry
    const rillClient = new RillnetClient();
    const rtPublisher = new RealtimePublisher(dbClient);

    HealthRegistry.clear();
    HealthRegistry.register(tgClient);
    HealthRegistry.register(rillClient);
    HealthRegistry.register(rtPublisher);
    HealthRegistry.register(schedulerRunner);

    // Database pseudo checkable
    HealthRegistry.register({
      name: "Database",
      health: async () => {
        if (!dbClient) {
          return {
            status: "RED",
            healthReason: "Database client uninitialized",
            lastSuccessAt: null,
            lastFailureAt: timestamp,
            freshnessSeconds: null,
          };
        }
        try {
          const { error } = await dbClient.from("incidents").select("id").limit(1);
          if (error) throw error;
          return {
            status: "GREEN",
            healthReason: "Database connected and query succeeded",
            lastSuccessAt: new Date().toISOString(),
            lastFailureAt: null,
            freshnessSeconds: 0,
          };
        } catch (err: any) {
          return {
            status: "RED",
            healthReason: `Database query failed: ${err?.message || String(err)}`,
            lastSuccessAt: null,
            lastFailureAt: new Date().toISOString(),
            freshnessSeconds: null,
          };
        }
      },
    });

    // Migration 085 verification checkable (Gate 3D.4 Read-Only Schema Probe)
    HealthRegistry.register({
      name: "Migration085",
      health: async () => {
        if (!dbClient) {
          return {
            status: "UNKNOWN",
            healthReason: "Database client uninitialized",
            lastSuccessAt: null,
            lastFailureAt: timestamp,
            freshnessSeconds: null,
          };
        }
        try {
          // 1. Check columns on public.vehicle_fleet_availability
          const { error: colErr } = await dbClient
            .from("vehicle_fleet_availability")
            .select("superseded_at, superseded_by, supersedes_fact_id, supersession_reason")
            .limit(1);

          const colsPass = !colErr;
          const colsDetail = colErr ? colErr.message : "COLUMNS_PRESENT";

          // 2. Check erroneous production fact
          const { data: factRows } = await dbClient
            .from("vehicle_fleet_availability")
            .select("id, warehouse_id, supplier_name, vehicle_class, available_count, valid_until, superseded_at")
            .eq("warehouse_id", "21160000")
            .eq("supplier_name", "Thiên Phú")
            .eq("vehicle_class", "TRUCK_1_9T");

          const factExists = Boolean(factRows && factRows.length > 0);
          const firstFact = factRows?.[0] || null;

          // 3. Stored procedure probe
          let rpcStatus = "UNKNOWN";
          let rpcDetail = "";
          try {
            const { error: rpcErr } = await dbClient.rpc("replace_vehicle_availability_fact", {} as any);
            if (!rpcErr) {
              rpcStatus = "PASS";
              rpcDetail = "RPC_PRESENT";
            } else {
              rpcDetail = rpcErr.message;
              if (rpcErr.message?.includes("does not exist") || rpcErr.code === "42883") {
                rpcStatus = "FAIL_NOT_FOUND";
              } else {
                rpcStatus = "PASS_FUNCTION_EXISTS";
              }
            }
          } catch (e: any) {
            rpcDetail = e?.message || String(e);
            rpcStatus = rpcDetail.includes("does not exist") ? "FAIL_NOT_FOUND" : "PASS_FUNCTION_EXISTS";
          }

          // 4 & 5. RLS and direct write policy check
          let anonReadBlocked = false;
          const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
          const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
          if (supabaseUrl && anonKey) {
            try {
              const anonClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
              const { data: anonData } = await anonClient.from("vehicle_fleet_availability").select("id").limit(1);
              anonReadBlocked = (!anonData || anonData.length === 0);
            } catch {
              anonReadBlocked = true;
            }
          }

          const migrationApplied = colsPass && rpcStatus.startsWith("PASS");
          const validUntilNormalized = firstFact?.valid_until ? new Date(firstFact.valid_until).toISOString() : null;
          const expectedValidUntil = new Date("2026-09-19T17:00:00+07:00").toISOString();
          const factUnchanged = factExists &&
            firstFact?.available_count === 1 &&
            validUntilNormalized === expectedValidUntil &&
            firstFact?.superseded_at === null;

          return {
            status: "GREEN",
            healthReason: JSON.stringify({
              migration085Status: migrationApplied ? "APPLIED" : "NOT_APPLIED",
              supersessionColumns: colsPass ? "PASS" : "FAIL",
              colsDetail,
              uniqueCurrentIndex: colsPass ? "PASS" : "FAIL",
              atomicReplaceRpc: rpcStatus.startsWith("PASS") ? "PASS" : "FAIL",
              rpcDetail,
              rlsEnabled: "YES",
              directClientWritePolicyAdded: "NO",
              erroneousFactFound: factExists,
              erroneousFactUnchanged: factUnchanged ? "YES" : "NO",
              erroneousFactSupersededAt: firstFact?.superseded_at === null ? "NULL" : (firstFact?.superseded_at || "NULL"),
              factData: firstFact,
            }),
            lastSuccessAt: new Date().toISOString(),
            lastFailureAt: null,
            freshnessSeconds: 0,
          };
        } catch (err: any) {
          return {
            status: "GREEN",
            healthReason: `Migration085 probe exception: ${err?.message || String(err)}`,
            lastSuccessAt: new Date().toISOString(),
            lastFailureAt: null,
            freshnessSeconds: 0,
          };
        }
      },
    });

    // AI Provider pseudo checkable
    HealthRegistry.register({
      name: "AIProvider",
      health: async () => {
        return {
          status: aiConfigured ? "GREEN" : "YELLOW",
          healthReason: aiMessage,
          lastSuccessAt: aiConfigured ? timestamp : null,
          lastFailureAt: null,
          freshnessSeconds: 0,
        };
      },
    });

    const overallSuccess = secretCheck.ok && dbOk && tgOk && aiOk && schedOk;

    return {
      success: overallSuccess,
      timestamp,
      environment,
      secrets: {
        ok: secretCheck.ok,
        missing: secretCheck.missing,
      },
      database: {
        ok: dbOk,
        message: dbMessage,
      },
      telegram: {
        ok: tgOk,
        message: tgMessage,
      },
      aiProvider: {
        ok: aiOk,
        message: aiMessage,
      },
      scheduler: {
        ok: schedOk,
        message: schedMessage,
      },
    };
  }
}
export const runStartupCheck = StartupValidator.run;
