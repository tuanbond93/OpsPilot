import {
  currentV1Attempt,
  endV1OperationSpan,
  safeBytes,
  startV1OperationSpan,
  type V1OperationSpan,
} from "./v1-attempt-telemetry";

/** Local V1 spans share the same hard-timeout-survivable protocol as DB calls. */
export type V1GapMetrics = {
  input_rows?: number | null;
  output_rows?: number | null;
  input_bytes?: number | null;
  output_bytes?: number | null;
};

type V1GapSpan = V1OperationSpan;

export function v1GapSerializedBytes(value: unknown): number | null {
  // Avoid serializing payloads outside a V1 attempt (including V2 paths).
  return currentV1Attempt() ? safeBytes(value) : null;
}

export function startV1GapSpan(
  operation_name: string,
  input: V1GapMetrics = {},
  table_or_rpc = "local_cpu",
): V1GapSpan | null {
  return startV1OperationSpan(operation_name, table_or_rpc, input);
}

export function endV1GapSpan(span: V1GapSpan | null, output: V1GapMetrics = {}, error?: unknown): void {
  endV1OperationSpan(span, output, error);
}

export async function traceV1Gap<T>(
  operation_name: string,
  input: V1GapMetrics,
  operation: () => Promise<T>,
  output: (value: T) => V1GapMetrics = () => ({}),
  table_or_rpc = "local_cpu",
): Promise<T> {
  const span = startV1GapSpan(operation_name, input, table_or_rpc);
  try {
    const value = await operation();
    endV1GapSpan(span, output(value));
    return value;
  } catch (error) {
    endV1GapSpan(span, {}, error);
    throw error;
  }
}

export function traceV1GapSync<T>(
  operation_name: string,
  input: V1GapMetrics,
  operation: () => T,
  output: (value: T) => V1GapMetrics = () => ({}),
  table_or_rpc = "local_cpu",
): T {
  const span = startV1GapSpan(operation_name, input, table_or_rpc);
  try {
    const value = operation();
    endV1GapSpan(span, output(value));
    return value;
  } catch (error) {
    endV1GapSpan(span, {}, error);
    throw error;
  }
}
