import { afterEach, describe, expect, it, vi } from "vitest";
import { safeBytes, setV1Input, traceV1Call, withV1Attempt } from "@/observability/v1-attempt-telemetry";

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
    const row = JSON.parse(messages[0]);
    expect(row).toMatchObject({ sync_run_id: "run", work_unit_id: "unit", attempt: 3,
      chunk_index: 2, request_id: "request", input_source: "cursor.metadata.chunkOrders",
      input_order_count: 1, input_bytes: safeBytes([{ customer: "PRIVATE_CUSTOMER" }]),
      operation_name: "followup_case_members_upsert", table_or_rpc: "followup_case_members",
      success: false, error_code: "57014", error_message: "statement timeout" });
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    expect(row.started_at).toBeTruthy();
    expect(row.ended_at).toBeTruthy();
    expect(messages[0]).not.toContain("PRIVATE_CUSTOMER");
  });

  it("does not let a broken logger affect the call result", async () => {
    vi.spyOn(console, "info").mockImplementation(() => { throw new Error("logger down"); });
    const result = await withV1Attempt(context(), () =>
      traceV1Call("case_read", "followup_cases", null, undefined, async () => ({ data: [{ id: 1 }], error: null })));
    expect(result.data).toEqual([{ id: 1 }]);
  });
});
