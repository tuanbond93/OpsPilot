export interface DeclarativeJob {
  name: string;
  description: string;
  schedule: string; // Cron expression or interval string e.g., "*/5 * * * *"
  enabled: boolean;
  handler: () => Promise<{ success: boolean; details?: string; error?: string }>;
}

export interface JobExecutionResult {
  jobName: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: "SUCCESS" | "FAILED";
  error?: string;
  details?: string;
}
