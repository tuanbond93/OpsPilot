import { AsyncLocalStorage } from "node:async_hooks";

export type V1AttemptContext = {
  sync_run_id: string;
  work_unit_id: string;
  chunk_index: number | null;
  attempt: number;
  request_id: string;
  input_source: string | null;
  input_order_count: number | null;
  input_bytes: number | null;
};

const storage = new AsyncLocalStorage<V1AttemptContext>();

export function withV1Attempt<T>(context: V1AttemptContext, run: () => Promise<T>): Promise<T> {
  return storage.run(context, run);
}

export function currentV1Attempt(): V1AttemptContext | undefined {
  return storage.getStore();
}

export function setV1Input(source: string, orders: unknown): void {
  const context = currentV1Attempt();
  if (!context) return;
  context.input_source = source;
  context.input_order_count = Array.isArray(orders) ? orders.length : null;
  context.input_bytes = safeBytes(orders);
}

export function safeBytes(value: unknown): number | null {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
  catch { return null; }
}

function safeError(error: unknown): { error_code: string | null; error_message: string | null } {
  const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof source.code === "string" && /^[A-Z0-9_]{1,32}$/i.test(source.code) ? source.code : null;
  // PostgREST's message can contain query values. Emit only recognized database error classes.
  const message = code === "57014" ? "statement timeout" : code ? "database error" : error ? "operation failed" : null;
  return { error_code: code, error_message: message };
}

export function emitV1Trace(details: {
  operation_name: string; table_or_rpc: string; started_at: string; ended_at: string;
  duration_ms: number; row_count: number | null; payload_bytes: number | null;
  success: boolean; error?: unknown;
}, context = currentV1Attempt()): void {
  if (!context) return;
  try {
    console.info(JSON.stringify({
      category: "V1_DB_ATTEMPT_TRACE", ...context,
      operation_name: details.operation_name, table_or_rpc: details.table_or_rpc,
      started_at: details.started_at, ended_at: details.ended_at,
      duration_ms: details.duration_ms, row_count: details.row_count,
      payload_bytes: details.payload_bytes, success: details.success,
      ...safeError(details.error),
    }));
  } catch { /* Telemetry must never affect the worker. */ }
}

export async function traceV1Call(
  operation_name: string, table_or_rpc: string, row_count: number | null,
  payload: unknown, call: () => PromiseLike<any>,
): Promise<any> {
  const context = currentV1Attempt();
  if (!context) return call();
  const started_at = new Date().toISOString();
  const start = performance.now();
  let error: unknown;
  let result: any;
  try {
    result = await call();
    const response = result && typeof result === "object" ? result as Record<string, unknown> : null;
    error = response?.error || undefined;
    return result;
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    const response = result && typeof result === "object" ? result as Record<string, unknown> : null;
    const data = response?.data;
    emitV1Trace({ operation_name, table_or_rpc, started_at, ended_at: new Date().toISOString(),
      duration_ms: Math.round((performance.now() - start) * 100) / 100,
      row_count: Array.isArray(data) ? data.length : Array.isArray(result) ? result.length : row_count,
      payload_bytes: payload === undefined ? null : safeBytes(payload), success: !error, error }, context);
  }
}
