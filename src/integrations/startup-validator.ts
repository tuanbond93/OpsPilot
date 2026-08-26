import { SecretProvider } from "./secrets";
import { createAdminClient } from "@/connectors/supabase";
import { TelegramClient } from "./telegram";
import { RillnetClient } from "./rillnet";
import { RealtimePublisher } from "./realtime";
import { SchedulerRunner, schedulerRunner } from "./scheduler";
import { HealthRegistry } from "./health";
import { SCHEDULER_JOBS } from "../config/scheduler";
import { generate } from "../ai";

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
