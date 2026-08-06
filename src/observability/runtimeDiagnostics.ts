import { appendFileSync } from "node:fs";
export function logRuntimeMessage(message: string): void {
  console.log(message);
  const outputPath = process.env.OPSPILOT_RUNTIME_LOG;
  if (outputPath) {
    try {
      appendFileSync(outputPath, message + "\n", "utf8");
    } catch {
      // Diagnostics must never change runtime behavior.
    }
  }
}
export interface RuntimeErrorDetails {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
  stack?: string;
}

export function getRuntimeErrorDetails(error: unknown): RuntimeErrorDetails {
  const source = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const message = error instanceof Error ? error.message : String(source.message ?? error);
  const details: RuntimeErrorDetails = { message };

  for (const key of ["code", "details", "hint", "stack"] as const) {
    const value = key === "stack" && error instanceof Error ? error.stack : source[key];
    if (typeof value === "string" && value.length > 0) details[key] = value;
  }

  return details;
}

export function logRuntimeError(scope: string, error: unknown): void {
  logRuntimeMessage(`[${scope}] error=${JSON.stringify(getRuntimeErrorDetails(error))}`);
}

export function serializedPayloadBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
