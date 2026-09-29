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

type V1AttemptStore = V1AttemptContext & {
  sequence_number: number;
  request_started_monotonic: number;
};

export type V1OperationMetrics = {
  input_rows?: number | null;
  input_bytes?: number | null;
  output_rows?: number | null;
  output_bytes?: number | null;
  output_payload?: unknown;
};

export type V1OperationSpan = {
  context: V1AttemptStore;
  operation_name: string;
  table_or_rpc: string;
  sequence_number: number;
  started_at: string;
  started_monotonic: number;
  input_rows: number | null;
  input_bytes: number | null;
};

const storage = new AsyncLocalStorage<V1AttemptStore>();

export function withV1Attempt<T>(context: V1AttemptContext, run: () => Promise<T>): Promise<T> {
  return storage.run({ ...context, sequence_number: 0, request_started_monotonic: performance.now() }, run);
}

export function currentV1Attempt(): V1AttemptContext | undefined {
  return storage.getStore();
}

export function setV1Input(source: string, orders: unknown): void {
  const context = storage.getStore();
  if (!context) return;
  context.input_source = source;
  context.input_order_count = Array.isArray(orders) ? orders.length : null;
  context.input_bytes = safeBytes(orders);
}

export function safeBytes(value: unknown): number | null {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
  catch { return null; }
}

function safeMemory(): { heap_used: number | null; rss: number | null } {
  try {
    const memory = process.memoryUsage();
    return { heap_used: memory.heapUsed, rss: memory.rss };
  } catch {
    return { heap_used: null, rss: null };
  }
}

export function safeV1Error(error: unknown): { error_code: string | null; error_message: string | null } {
  const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const candidate = typeof source.code === "string" ? source.code : null;
  const code = candidate && /^[A-Z0-9_]{1,32}$/i.test(candidate) ? candidate : null;
  // PostgREST errors may carry query values. Keep only a stable error class.
  const message = code === "57014" ? "statement timeout" : code ? "database error" : error ? "operation failed" : null;
  return { error_code: code, error_message: message };
}

function emitOperationEvent(event: Record<string, unknown>): void {
  try { console.info(JSON.stringify(event)); }
  catch { /* Telemetry must never affect the worker. */ }
}

function correlationFields(context: V1AttemptStore): V1AttemptContext {
  const { sequence_number: _sequence_number, request_started_monotonic: _request_started_monotonic, ...fields } = context;
  return fields;
}

/**
 * Emits synchronously before an operation starts. If a hard runtime kill happens
 * before endV1OperationSpan, this event is the durable forensic breadcrumb.
 */
export function startV1OperationSpan(
  operation_name: string,
  table_or_rpc: string,
  metrics: Pick<V1OperationMetrics, "input_rows" | "input_bytes"> = {},
  context = storage.getStore(),
): V1OperationSpan | null {
  if (!context) return null;
  const sequence_number = ++context.sequence_number;
  const started_at = new Date().toISOString();
  const started_monotonic = performance.now();
  const input_rows = metrics.input_rows ?? null;
  const input_bytes = metrics.input_bytes ?? null;
  const memory = safeMemory();
  emitOperationEvent({
    category: "V1_OPERATION_SPAN",
    trace_type: "OPERATION_START",
    ...correlationFields(context),
    sequence_number,
    operation_name,
    table_or_rpc,
    timestamp: started_at,
    monotonic_elapsed_ms: Number((started_monotonic - context.request_started_monotonic).toFixed(2)),
    input_rows,
    input_bytes,
    heap_used: memory.heap_used,
    rss: memory.rss,
  });
  return { context, operation_name, table_or_rpc, sequence_number, started_at, started_monotonic, input_rows, input_bytes };
}

/** Emits synchronously on completion or catch; it never awaits or persists telemetry. */
export function endV1OperationSpan(
  span: V1OperationSpan | null,
  metrics: Omit<V1OperationMetrics, "input_rows" | "input_bytes"> = {},
  error?: unknown,
): void {
  if (!span) return;
  const ended_at = new Date().toISOString();
  const ended_monotonic = performance.now();
  const memory = safeMemory();
  const safeError = safeV1Error(error);
  emitOperationEvent({
    category: "V1_OPERATION_SPAN",
    trace_type: "OPERATION_END",
    ...correlationFields(span.context),
    sequence_number: span.sequence_number,
    operation_name: span.operation_name,
    table_or_rpc: span.table_or_rpc,
    timestamp: ended_at,
    monotonic_elapsed_ms: Number((ended_monotonic - span.context.request_started_monotonic).toFixed(2)),
    input_rows: span.input_rows,
    input_bytes: span.input_bytes,
    heap_used: memory.heap_used,
    rss: memory.rss,
    duration_ms: Number((ended_monotonic - span.started_monotonic).toFixed(2)),
    output_rows: metrics.output_rows ?? null,
    output_bytes: metrics.output_bytes ?? (metrics.output_payload === undefined ? null : safeBytes(metrics.output_payload)),
    success: !error,
    error_code: safeError.error_code,
    sanitized_error_message: safeError.error_message,
  });
}

/** Finds the forensic rule used after a hard runtime kill. */
export function lastUnmatchedV1OperationStart(events: unknown[]): Record<string, unknown> | null {
  const starts = new Map<number, Record<string, unknown>>();
  for (const candidate of events) {
    if (!candidate || typeof candidate !== "object") continue;
    const event = candidate as Record<string, unknown>;
    if (event.category !== "V1_OPERATION_SPAN" || typeof event.sequence_number !== "number") continue;
    if (event.trace_type === "OPERATION_START") starts.set(event.sequence_number, event);
    if (event.trace_type === "OPERATION_END") starts.delete(event.sequence_number);
  }
  return [...starts.values()].sort((a, b) => Number(b.sequence_number) - Number(a.sequence_number))[0] ?? null;
}

export function emitV1Trace(details: {
  operation_name: string; table_or_rpc: string; started_at: string; ended_at: string;
  duration_ms: number; row_count: number | null; payload_bytes: number | null;
  success: boolean; error?: unknown;
}, context = storage.getStore()): void {
  if (!context) return;
  try {
    console.info(JSON.stringify({
      category: "V1_DB_ATTEMPT_TRACE", ...correlationFields(context),
      operation_name: details.operation_name, table_or_rpc: details.table_or_rpc,
      started_at: details.started_at, ended_at: details.ended_at,
      duration_ms: details.duration_ms, row_count: details.row_count,
      payload_bytes: details.payload_bytes, success: details.success,
      ...safeV1Error(details.error),
    }));
  } catch { /* Telemetry must never affect the worker. */ }
}

export async function traceV1Call(
  operation_name: string, table_or_rpc: string, row_count: number | null,
  payload: unknown, call: () => PromiseLike<any>,
): Promise<any> {
  const context = storage.getStore();
  if (!context) return call();
  const payload_bytes = payload === undefined ? null : safeBytes(payload);
  const span = startV1OperationSpan(operation_name, table_or_rpc, { input_rows: row_count, input_bytes: payload_bytes }, context);
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
    const output_rows = Array.isArray(data) ? data.length : Array.isArray(result) ? result.length : row_count;
    endV1OperationSpan(span, { output_rows, output_payload: data }, error);
    emitV1Trace({ operation_name, table_or_rpc, started_at: span?.started_at ?? new Date().toISOString(), ended_at: new Date().toISOString(),
      duration_ms: span ? Math.round((performance.now() - span.started_monotonic) * 100) / 100 : 0,
      row_count: output_rows, payload_bytes, success: !error, error }, context);
  }
}
