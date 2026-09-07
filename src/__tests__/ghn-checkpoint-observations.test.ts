import { describe, it, expect, vi } from "vitest";
import { collectGhnCheckpointObservations, prioritizePilotCheckpointCandidates } from "@/services/ghn-checkpoint-observations";
import { GhnOrderTrackingClient, GhnTrackingError } from "@/connectors/ghn-order-tracking";
import type { OrderEvidence } from "@/domain/operational-learning/checkpoint-policy";

const now = Date.parse("2026-09-06T03:01:00Z");
const noWait = async () => undefined;
const order: OrderEvidence = { orderCode: "ORDER1", customerId: "123", warehouseId: "456", stage: "DELIVERY", status: "storing", observedAt: new Date(now).toISOString(), readyAt: "2026-09-05T22:00:00Z" };
function client(logs: unknown[]) {
  const result = new GhnOrderTrackingClient();
  vi.spyOn(result, "fetchOrderLogs").mockResolvedValue(logs as any);
  return result;
}
describe("server GHN checkpoint evidence", () => {
  it("replaces delayed storing with GHN delivering and preserves event and check time", async () => {
    const result = await collectGhnCheckpointObservations([order, order], client([{ created_at: "2026-09-06T02:55:00Z", new_data: { status: "delivering", client_id: 123, current_warehouse_id: 456 } }]), () => now, noWait);
    expect(result.observations.get("ORDER1")).toMatchObject({ status: "delivering", source: "ghn_internal_order_logs", eventAt: "2026-09-06T02:55:00Z", observedAt: new Date(now).toISOString() });
    expect(result.failures).toEqual({});
  });
  it("never substitutes Rillnet when authentication expires", async () => {
    const api = client([]);
    vi.mocked(api.fetchOrderLogs).mockRejectedValue(new GhnTrackingError("rejected", "UNAUTHORIZED"));
    const result = await collectGhnCheckpointObservations([order], api, () => now, noWait);
    expect(result.observations.size).toBe(0);
    expect(result.failures.ORDER1).toBe("UNAUTHORIZED");
  });
  it.each([{ logs: [] }, { logs: [{ created_at: "2026-09-06T02:55:00Z", new_data: { status: "delivered", client_id: 999, current_warehouse_id: 456 } }] }])("rejects empty or wrong-customer logs", async ({ logs }) => {
    const result = await collectGhnCheckpointObservations([order], client(logs), () => now, noWait);
    expect(result.observations.size).toBe(0);
    expect(result.failures.ORDER1).toBe("INCOMPLETE_OR_MISMATCHED_EVIDENCE");
  });
  it("does not truncate the pilot cohort at 100 orders", async () => {
    const api = client([]);
    const result = await collectGhnCheckpointObservations(Array.from({ length: 105 }, (_, i) => ({ ...order, orderCode: `ORDER${i}` })), api, () => now, noWait);
    expect(api.fetchOrderLogs).toHaveBeenCalledTimes(105);
    expect(result.failures.ORDER104).toBe("INCOMPLETE_OR_MISMATCHED_EVIDENCE");
  });
  it("reserves the request budget for MB03 and checks due work first", () => {
    const future = { ...order, orderCode: "MB3-FUTURE", warehouseId: "20121005", dueAt: "2026-09-07T03:00:00Z" };
    const due = { ...order, orderCode: "MB3-DUE", warehouseId: "20121005", dueAt: "2026-09-06T02:00:00Z" };
    const outside = { ...order, orderCode: "OUTSIDE-DUE", warehouseId: "1070", dueAt: "2026-09-06T01:00:00Z" };
    expect(prioritizePilotCheckpointCandidates([future, outside, due], now).map(item => item.orderCode))
      .toEqual(["MB3-DUE", "MB3-FUTURE"]);
  });
});
