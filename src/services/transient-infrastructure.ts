import { getRuntimeErrorDetails } from "@/observability/runtimeDiagnostics";

export const TRANSIENT_INFRASTRUCTURE_MAX_ATTEMPTS = 3;
export const TRANSIENT_INFRASTRUCTURE_DELAYS_MS = [2_000, 5_000] as const;

export type TransientRetryTelemetry = {
  attempts: number;
  retryCount: number;
  finalStatus: "SUCCESS" | "NON_RETRYABLE_FAILURE" | "TRANSIENT_FAILURE";
};

type ErrorShape = { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };

function text(error: unknown): string {
  const details = getRuntimeErrorDetails(error);
  const shape = error && typeof error === "object" ? error as ErrorShape : {};
  return [details.message, details.code, shape.status, shape.statusCode].filter((value) => value != null).join(" ").toLowerCase();
}

/** Only infrastructure failures that are safe to retry belong in this class. */
export function isTransientInfrastructureError(error: unknown): boolean {
  const value = text(error);
  if (/\b(401|403)\b/.test(value) || /(auth|permission denied|forbidden|invalid rpc|schema|malformed|validation|sync_already_running|lock held|lock_held)/.test(value)) return false;
  if (/\b(502|503|504)\b/.test(value)) return true;
  return /(gateway timeout|upstream timeout|temporary network|temporar(?:y|ily)|transient fetch|fetch failed|network (?:failure|error)|econnreset|econnrefused|etimedout|connection timeout)/.test(value);
}

export async function retryTransientInfrastructure<T>(
  operation: () => Promise<T>,
  options: { sleep?: (delayMs: number) => Promise<void>; random?: () => number } = {}
): Promise<{ value: T; telemetry: TransientRetryTelemetry }> {
  const sleep = options.sleep || ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const random = options.random || Math.random;
  let lastError: unknown;
  const attachTelemetry = (error: unknown, telemetry: TransientRetryTelemetry): Error => {
    const base = error instanceof Error
      ? error
      : Object.assign(new Error(getRuntimeErrorDetails(error).message), error && typeof error === "object" ? error : {});
    return Object.assign(base, { transientRetryTelemetry: telemetry });
  };

  for (let attempt = 1; attempt <= TRANSIENT_INFRASTRUCTURE_MAX_ATTEMPTS; attempt++) {
    try {
      const value = await operation();
      return { value, telemetry: { attempts: attempt, retryCount: attempt - 1, finalStatus: "SUCCESS" } };
    } catch (error) {
      lastError = error;
      if (!isTransientInfrastructureError(error)) {
        throw attachTelemetry(error, { attempts: attempt, retryCount: attempt - 1, finalStatus: "NON_RETRYABLE_FAILURE" });
      }
      if (attempt === TRANSIENT_INFRASTRUCTURE_MAX_ATTEMPTS) break;
      const baseDelay = TRANSIENT_INFRASTRUCTURE_DELAYS_MS[attempt - 1];
      const jitteredDelay = Math.round(baseDelay * (0.9 + random() * 0.2));
      await sleep(jitteredDelay);
    }
  }

  throw attachTelemetry(lastError, { attempts: TRANSIENT_INFRASTRUCTURE_MAX_ATTEMPTS, retryCount: TRANSIENT_INFRASTRUCTURE_MAX_ATTEMPTS - 1, finalStatus: "TRANSIENT_FAILURE" });
}

export function retryTelemetryFrom(error: unknown): TransientRetryTelemetry | null {
  const value = error && typeof error === "object" ? (error as { transientRetryTelemetry?: unknown }).transientRetryTelemetry : null;
  if (!value || typeof value !== "object") return null;
  const telemetry = value as Partial<TransientRetryTelemetry>;
  return typeof telemetry.attempts === "number" && typeof telemetry.retryCount === "number" && typeof telemetry.finalStatus === "string"
    ? telemetry as TransientRetryTelemetry
    : null;
}
