import { SchedulerRunner } from "./scheduler-runner";
import { logger } from "@/observability/logger";

/**
 * Ensures that the scheduler's Job Registry is loaded and contains registered jobs.
 * This is designed to be called at the entry point of route handlers that execute cron jobs
 * to resolve the lazy-initialization startup bug.
 */
export async function ensureSchedulerInitialized(): Promise<void> {
  const currentJobs = SchedulerRunner.getJobs();
  if (currentJobs.length > 0) {
    return; // Already initialized, skip registration to prevent duplicates
  }

  logger.info({
    component: "SchedulerInitializer",
    operation: "initializeScheduler",
    status: "start",
    message: "[Scheduler] Initializing Job Registry...",
  });

  // Dynamically import StartupValidator to avoid circular dependency issues at startup
  const { StartupValidator } = await import("../startup-validator");
  await StartupValidator.run();

  const finalJobs = SchedulerRunner.getJobs();
  if (finalJobs.length === 0) {
    throw new Error("[Scheduler] FATAL: Job Registry remains empty after initialization.");
  }

  logger.info({
    component: "SchedulerInitializer",
    operation: "initializeScheduler",
    status: "success",
    message: "[Scheduler] Initialization complete.",
    metadata: {
      jobCount: finalJobs.length,
    },
  });
}
