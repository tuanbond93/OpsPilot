import { afterEach, describe, expect, it, vi } from "vitest";
import {
  lastUnmatchedV1OperationStart,
  safeBytes,
  setV1Input,
  startV1OperationSpan,
  traceV1Call,
  withV1Attempt,
} from "@/observability/v1-attempt-telemetry";

const context = () => ({ sync_run_id: "run", work_unit_id: "unit", chunk_index: 2,
  attempt: 3, request_id: "request", input_source: null, input_order_count: null, input_bytes: null });

afterEach(() => vi.restoreAllMocks());

describe("V1 attempt telemetry", () => {
  it("correlates a failed database call without logging payload contents", async () => {
    const messages: string[] = [];
    vi.spyOn(console, "info").mockImplementation(message => { messages.push(message); });
    await withV1Attempt(context(), async () => {
      setV1Input("cursor.metadata.chunkOrders", [{ customer: "PRIVATE_CUSTOMER" }]);
      const response = await traceV1Call("followup_case_members_upsert", "followup_case_members", 1,
        [{ customer: "PRIVATE_CUSTOMER" }], async () => ({ data: null, error: { code: "57014", message: "PRIVATE_CUSTOMER" } }));
      expect(response.error.code).toBe("57014");
    });
    const events = messages.map(message => JSON.parse(message));
    const start = events.find(event => event.trace_type === "OPERATION_START");
    const end = events.find(event => event.trace_type === "OPERATION_END");
    const row = events.find(event => event.category === "V1_DB_ATTEMPT_TRACE");
    expect(start).toMatchObject({ category: "V1_OPERATION_SPAN", trace_type: "OPERATION_START", sequence_number: 1,
      sync_run_id: "run", work_unit_id: "unit", attempt: 3, chunk_index: 2, request_id: "request",
      operation_name: "followup_case_members_upsert", table_or_rpc: "followup_case_members" });
    expect(end).toMatchObject({ category: "V1_OPERATION_SPAN", trace_type: "OPERATION_END", sequence_number: 1,
      success: false, error_code: "57014", sanitized_error_message: "statement timeout" });
    expect(row).toMatchObject({ sync_run_id: "run", work_unit_id: "unit", attempt: 3,
      chunk_index: 2, request_id: "request", input_source: "cursor.metadata.chunkOrders",
      input_order_count: 1, input_bytes: safeBytes([{ customer: "PRIVATE_CUSTOMER" }]),
      operation_name: "followup_case_members_upsert", table_or_rpc: "followup_case_members",
      success: false, error_code: "57014", error_message: "statement timeout" });
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    expect(row.started_at).toBeTruthy();
    expect(row.ended_at).toBeTruthy();
    expect(messages.join("\n")).not.toContain("PRIVATE_CUSTOMER");
  });

  it("does not let a broken logger affect the call result", async () => {
    vi.spyOn(console, "info").mockImplementation(() => { throw new Error("logger down"); });
    const result = await withV1Attempt(context(), () =>
      traceV1Call("case_read", "followup_cases", null, undefined, async () => ({ data: [{ id: 1 }], error: null })));
    expect(result.data).toEqual([{ id: 1 }]);
  });

  it("emits a matched START and END for a normal successful call", async () => {
    const messages: string[] = [];
    vi.spyOn(console, "info").mockImplementation(message => { messages.push(message); });
    await withV1Attempt(context(), () =>
      traceV1Call("case_read", "followup_cases", 25, { bounded: true }, async () => ({ data: [{ id: "case" }], error: null })));
    const spans = messages.map(message => JSON.parse(message)).filter(event => event.category === "V1_OPERATION_SPAN");
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ trace_type: "OPERATION_START", sequence_number: 1, input_rows: 25 });
    expect(spans[1]).toMatchObject({ trace_type: "OPERATION_END", sequence_number: 1, success: true, output_rows: 1 });
    expect(lastUnmatchedV1OperationStart(spans)).toBeNull();
  });

  it("leaves an unmatched START for a test-only hard-timeout interruption", async () => {
    const messages: string[] = [];
    vi.spyOn(console, "info").mockImplementation(message => { messages.push(message); });
    await withV1Attempt(context(), async () => {
      startV1OperationSpan("simulated_long_running_operation", "test_only", { input_rows: 25, input_bytes: 2_000_000 });
      await expect(Promise.race([
        new Promise<void>(() => { /* Simulates an operation killed outside this process. */ }),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("TEST_ONLY_TIMEOUT")), 5)),
      ])).rejects.toThrow("TEST_ONLY_TIMEOUT");
      // Deliberately no END: a Vercel hard kill cannot execute a finally block.
    });
    const events = messages.map(message => JSON.parse(message));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ trace_type: "OPERATION_START", operation_name: "simulated_long_running_operation" });
    expect(lastUnmatchedV1OperationStart(events)).toMatchObject({
      operation_name: "simulated_long_running_operation", table_or_rpc: "test_only", sequence_number: 1,
    });
  });
});
