import { describe, expect, it } from "vitest";
import { mapRawOrderToNormalized } from "../connectors/rillnet/mapper";

describe("Rillnet journey evidence mapper", () => {
  it("preserves pickup and route timestamps used by deterministic root cause", () => {
    const order = mapRawOrderToNormalized({
      order_code: "GY8N9V8T",
      status: "storing",
      current_warehouse_id: 21160000,
      created_date: "2026-08-14T09:43:39.806Z",
      end_pick_time: "2026-08-20T14:52:47.058Z",
      pick_warehouse_id: 1327,
      deliver_warehouse_id: 21160000,
      warehouse_log: '[{"warehouse_id":21652000,"time":"2026-08-23T00:47:27.966Z"}]',
    }, "2026-08-23T01:00:00.000Z");

    expect(order.pickWarehouseId).toBe("1327");
    expect(order.deliverWarehouseId).toBe("21160000");
    expect(order.endPickAt).toBe("2026-08-20T14:52:47.058Z");
    expect(order.warehouseLog).toHaveLength(1);
  });

  it("treats malformed journey logs as unavailable rather than failing sync", () => {
    const order = mapRawOrderToNormalized({ order_code: "BAD-LOG", status: "storing", warehouse_log: "not-json" }, "2026-08-23T01:00:00.000Z");
    expect(order.warehouseLog).toEqual([]);
  });

  it.each([
    ["5152151", "Hồng Đạt"],
    ["5386469", "Cocoon"],
  ])("maps manually confirmed Rillnet client %s to %s", (clientId, expectedName) => {
    const order = mapRawOrderToNormalized({ order_code: `ORDER-${clientId}`, status: "storing", client_id: clientId }, "2026-08-25T08:00:00.000Z");
    expect(order.customerName).toBe(expectedName);
  });
});
