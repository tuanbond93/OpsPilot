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
      deliver_warehouse_name: "Kho giao cuối",
      to_province_id_v2: 79,
      to_district_id: 145,
      sort_code: "A1",
      is_b2b: true,
      max_weight: 200,
      warehouse_log: '[{"warehouse_id":21652000,"time":"2026-08-23T00:47:27.966Z"}]',
    }, "2026-08-23T01:00:00.000Z");

    expect(order.pickWarehouseId).toBe("1327");
    expect(order.deliverWarehouseId).toBe("21160000");
    expect(order.deliverWarehouseName).toBe("Kho giao cuối");
    expect(order.destinationProvinceId).toBe("79");
    expect(order.destinationDistrictId).toBe("145");
    expect(order.sortCode).toBe("A1");
    expect(order.isB2b).toBe(true);
    expect(order.weightGrams).toBe(200);
    expect(order.weightKg).toBe(0.2);
    expect(order.endPickAt).toBe("2026-08-20T14:52:47.058Z");
    expect(order.warehouseLog).toHaveLength(1);
  });

  it.each([
    [233556, 233.556],
    [200, 0.2],
  ])("normalizes owner-verified gram weight %s without rounding", (rawWeight, expectedKg) => {
    const order = mapRawOrderToNormalized({ order_code: `WEIGHT-${rawWeight}`, max_weight: rawWeight }, "2026-08-23T01:00:00.000Z");

    expect(order.weightGrams).toBe(rawWeight);
    expect(order.weightKg).toBe(expectedKg);
  });

  it.each([undefined, null, -1, Number.NaN, Number.POSITIVE_INFINITY, "233556"])(
    "keeps invalid or missing weight %s as null",
    (rawWeight) => {
      const order = mapRawOrderToNormalized({ order_code: "INVALID-WEIGHT", max_weight: rawWeight }, "2026-08-23T01:00:00.000Z");

      expect(order.weightGrams).toBeNull();
      expect(order.weightKg).toBeNull();
    },
  );

  it("treats malformed journey logs as unavailable rather than failing sync", () => {
    const order = mapRawOrderToNormalized({ order_code: "BAD-LOG", status: "storing", warehouse_log: "not-json" }, "2026-08-23T01:00:00.000Z");
    expect(order.warehouseLog).toEqual([]);
    expect(order.weightGrams).toBeNull();
    expect(order.weightKg).toBeNull();
    expect(order.destinationProvinceId).toBeNull();
    expect(order.destinationDistrictId).toBeNull();
    expect(order.deliverWarehouseName).toBeNull();
    expect(order.sortCode).toBeNull();
    expect(order.isB2b).toBeNull();
  });

  it.each([
    ["5152151", "Hồng Đạt"],
    ["5386469", "Cocoon"],
  ])("maps manually confirmed Rillnet client %s to %s", (clientId, expectedName) => {
    const order = mapRawOrderToNormalized({ order_code: `ORDER-${clientId}`, status: "storing", client_id: clientId }, "2026-08-25T08:00:00.000Z");
    expect(order.customerName).toBe(expectedName);
  });
});
