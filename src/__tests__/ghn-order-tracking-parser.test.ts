import { describe, expect, it } from "vitest";
import { parseLiveOrderTracking } from "@/connectors/ghn-order-tracking";

describe("GHN live order tracking parser", () => {
  it("replays dynamic order logs and builds the visited warehouse chain", () => {
    const result = parseLiveOrderTracking("ORDER_DYNAMIC_01", [
      {
        created_at: "2026-08-21T07:25:23.000Z",
        old_data: { current_warehouse_id: 21365000, action: "TRANSPORTING" },
        new_data: { current_warehouse_id: 1121, action: "RECEIVED_AT_SORTING" },
      },
      {
        created_at: "2026-08-20T12:22:26.000Z",
        old_data: { current_warehouse_id: 22958000 },
        new_data: { current_warehouse_id: 21365000, status: "storing", action: "UNPACKED_AT_SORTING" },
      },
      {
        created_at: "2026-08-19T10:11:45.000Z",
        old_data: {},
        new_data: { current_warehouse_id: 22958000, pick_warehouse_id: 22958000, deliver_warehouse_id: 20749000, status: "ready_to_pick" },
      },
      {
        created_at: "2026-08-21T16:07:13.000Z",
        old_data: { action: "TRANSFER_TO_TRUCK" },
        new_data: { action: "TRANSPORTING", status: "transporting", next_warehouse_id: 21321000 },
      },
    ], {
      "22958000": "Kho lấy",
      "21365000": "Kho trung chuyển 1",
      "1121": "Kho trung chuyển 2",
      "21321000": "Kho tiếp theo",
      "20749000": "Bưu cục giao cuối",
    }, "2026-08-25T08:00:00.000Z");

    expect(result.orderCode).toBe("ORDER_DYNAMIC_01");
    expect(result.status).toBe("transporting");
    expect(result.phase).toBe("IN_TRANSIT");
    expect(result.currentWarehouseId).toBe("1121");
    expect(result.nextWarehouseId).toBe("21321000");
    expect(result.deliverWarehouseName).toBe("(DBI) Tuần Giáo");
    expect(result.journey.map((point) => point.warehouseId)).toEqual(["22958000", "21365000", "1121"]);
    expect(result.journey.every((point) => !point.current)).toBe(true);
  });

  it("prefers the canonical warehouse directory when external metadata has an obsolete name", () => {
    const result = parseLiveOrderTracking("GY8N99D4", [{
      created_at: "2026-08-25T02:00:00.000Z",
      new_data: { current_warehouse_id: 21158000, deliver_warehouse_id: 21448000, status: "storing" },
    }], { "21448000": "Bưu Cục Số 028 Thanh Niên-Than Uyên-Lai Châu" });
    expect(result.deliverWarehouseName).toBe("(LCH) Than Uyên");
    expect(result.deliverWarehouseType).toBe("Bưu cục");
  });

  it("marks the last warehouse current when the latest state is storing", () => {
    const result = parseLiveOrderTracking("ANOTHER_ORDER", [{
      created_at: "2026-08-25T02:00:00.000Z",
      old_data: {},
      new_data: { current_warehouse_id: 21652000, status: "storing", action: "RECEIVED_AT_SORTING" },
    }], { "21652000": "Kho Chuyển Tiếp Phú Thọ" });

    expect(result.statusLabel).toBe("Đang lưu tại kho");
    expect(result.currentWarehouseName).toBe("Kho Chuyển Tiếp Phú Thọ");
    expect(result.journey[0]).toMatchObject({ current: true, warehouseId: "21652000" });
  });

  it("preserves the first delivery start and successful delivery timestamps", () => {
    const result = parseLiveOrderTracking("DELIVERED_ORDER", [
      { created_at: "2026-08-22T00:57:48.000Z", new_data: { current_warehouse_id: 21160000, deliver_warehouse_id: 21160000, status: "storing" } },
      { created_at: "2026-08-25T01:00:00.000Z", new_data: { current_warehouse_id: 21160000, status: "delivering" } },
      { created_at: "2026-08-25T06:12:05.000Z", new_data: { current_warehouse_id: 21160000, status: "delivered" } },
    ]);
    expect(result.deliveryStartedAt).toBe("2026-08-25T01:00:00.000Z");
    expect(result.endDeliveryAt).toBe("2026-08-25T06:12:05.000Z");
    expect(result.endSuccessAt).toBe("2026-08-25T06:12:05.000Z");
  });

  it("exposes an inferred delivery assignment log when the source only reports the final delivering event", () => {
    const result = parseLiveOrderTracking("DELIVERING_WITHOUT_ASSIGN_LOG", [
      { created_at: "2026-08-23T06:11:54.000Z", new_data: { current_warehouse_id: 21160000, status: "storing" } },
      { created_at: "2026-08-25T02:52:53.000Z", new_data: { current_warehouse_id: 21160000, status: "delivering" } },
    ]);
    expect(result.deliveryStartedAt).toBe("2026-08-25T02:52:53.000Z");
    expect(result.deliveryStartedAtInferred).toBe(true);
  });

  it("reads delivery action variants when the GHN status field is absent", () => {
    const result = parseLiveOrderTracking("ACTION_ONLY_DELIVERY", [
      { created_at: "2026-08-27T05:18:24.000Z", new_data: { current_warehouse_id: 21321001, action: "OUT_FOR_DELIVERY" } },
      { created_at: "2026-08-27T05:21:04.000Z", new_data: { current_warehouse_id: 21321001, operation: "DELIVERY_SUCCESS" } },
    ]);
    expect(result.deliveryStartedAt).toBe("2026-08-27T05:18:24.000Z");
    expect(result.endSuccessAt).toBe("2026-08-27T05:21:04.000Z");
  });
});
