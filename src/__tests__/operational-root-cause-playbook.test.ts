import { describe, expect, it } from "vitest";
import { diagnoseOperationalJourney, groupOperationalDiagnoses } from "@/domain/operational-learning/root-cause-playbook";
import type { LiveOrderTracking } from "@/connectors/ghn-order-tracking";

function tracking(overrides: Partial<LiveOrderTracking>): LiveOrderTracking {
  return {
    orderCode: "ORDER1", customerId: "5035963", customerName: "MDLZ", status: "storing", statusLabel: "Đang lưu tại kho", phase: "AT_WAREHOUSE",
    currentWarehouseId: null, currentWarehouseName: null, nextWarehouseId: null, nextWarehouseName: null, pickWarehouseId: null, deliverWarehouseId: null,
    lastAction: null, lastEventAt: null, checkedAt: "2026-08-25T08:00:00.000Z", journey: [], ...overrides,
  };
}

describe("operational root-cause playbook", () => {
  it("learns the two separate CPTT warehouse failures from case 1", () => {
    const diagnosis = diagnoseOperationalJourney(tracking({
      orderCode: "GY89MK8V_CPTT", currentWarehouseId: "21652000", currentWarehouseName: "Kho Chuyển Tiếp Phú Thọ 01",
      journey: [
        { warehouseId: "21160000", warehouseName: "Kho Giao Hàng Nặng Việt Trì-Phú Thọ", arrivedAt: "2026-08-15T15:08:18.000Z", departedAt: "2026-08-20T17:13:35.000Z", current: false },
        { warehouseId: "21652000", warehouseName: "Kho Chuyển Tiếp Phú Thọ 01", arrivedAt: "2026-08-20T17:13:35.000Z", current: true },
      ],
    }));
    expect(diagnosis.orderType).toBe("DOCUMENT_RETURN_CPTT");
    expect(diagnosis.findings.map((item) => item.code)).toEqual(["CPTT_GHN_OUTBOUND_DELAY", "TRANSIT_WAREHOUSE_NOT_EXPORTED"]);
  });

  it("flags a transit warehouse that has not exported after receiving the order", () => {
    const diagnosis = diagnoseOperationalJourney(tracking({
      orderCode: "GY8TARPU", currentWarehouseId: "21652000", currentWarehouseName: "Kho Chuyển Tiếp Phú Thọ 01",
      journey: [{ warehouseId: "21652000", warehouseName: "Kho Chuyển Tiếp Phú Thọ 01", arrivedAt: "2026-08-23T04:17:20.000Z", current: true }],
    }));
    expect(diagnosis.findings).toHaveLength(1);
    expect(diagnosis.findings[0]).toMatchObject({ code: "TRANSIT_WAREHOUSE_NOT_EXPORTED", ownerWarehouseId: "21652000" });
  });

  it("flags GY8HMVUL after it misses the 07:00 KCT COT without waiting 12 hours", () => {
    const diagnosis = diagnoseOperationalJourney(tracking({
      orderCode: "GY8HMVUL", checkedAt: "2026-08-25T08:06:06.363Z",
      currentWarehouseId: "21652000", currentWarehouseName: "Kho Chuyển Tiếp Phú Thọ",
      journey: [{ warehouseId: "21652000", warehouseName: "Kho Chuyển Tiếp Phú Thọ", arrivedAt: "2026-08-24T21:25:56.222Z", current: true }],
    }));
    expect(diagnosis.findings).toHaveLength(1);
    expect(diagnosis.findings[0]).toMatchObject({ code: "TRANSIT_WAREHOUSE_NOT_EXPORTED", ownerWarehouseId: "21652000" });
  });

  it("routes KCT-to-GHN follow-up to the destination GHN warehouse", () => {
    const diagnosis = diagnoseOperationalJourney(tracking({
      currentWarehouseId: "21652000", currentWarehouseName: "Kho Chuyển Tiếp Phú Thọ 01",
      nextWarehouseId: "21160000", nextWarehouseName: "Kho Giao Hàng Nặng Việt Trì-Phú Thọ",
      journey: [{ warehouseId: "21652000", warehouseName: "Kho Chuyển Tiếp Phú Thọ 01", arrivedAt: "2026-08-23T04:17:20.000Z", current: true }],
    }));
    expect(diagnosis.findings[0]).toMatchObject({ code: "TRANSIT_TO_GHN_NOT_EXPORTED", ownerWarehouseId: "21160000" });
  });

  it("routes KCT-to-hub follow-up to the current transit warehouse", () => {
    const diagnosis = diagnoseOperationalJourney(tracking({
      currentWarehouseId: "21652000", currentWarehouseName: "Kho Chuyển Tiếp Phú Thọ 01",
      nextWarehouseId: "1121", nextWarehouseName: "Kho Trung Chuyển Hà Nội 02",
      journey: [{ warehouseId: "21652000", warehouseName: "Kho Chuyển Tiếp Phú Thọ 01", arrivedAt: "2026-08-23T04:17:20.000Z", current: true }],
    }));
    expect(diagnosis.findings[0]).toMatchObject({ code: "TRANSIT_TO_HUB_NOT_EXPORTED", ownerWarehouseId: "21652000" });
  });

  it("flags morning GHN intake that is still storing instead of assigned for delivery", () => {
    const diagnosis = diagnoseOperationalJourney(tracking({
      currentWarehouseId: "21160000", currentWarehouseName: "Kho Giao Hàng Nặng Việt Trì-Phú Thọ",
      checkedAt: "2026-08-25T08:00:00.000Z",
      journey: [{ warehouseId: "21160000", warehouseName: "Kho Giao Hàng Nặng Việt Trì-Phú Thọ", arrivedAt: "2026-08-25T02:00:00.000Z", current: true }],
    }));
    expect(diagnosis.findings).toHaveLength(1);
    expect(diagnosis.findings[0]).toMatchObject({ code: "GHN_MORNING_INTAKE_NOT_ASSIGNED_DELIVERY", ownerWarehouseId: "21160000" });
  });

  it("learns the three distinct failures from case 3", () => {
    const diagnosis = diagnoseOperationalJourney(tracking({
      orderCode: "GY8N9V8M", currentWarehouseId: "21160000", currentWarehouseName: "Kho Giao Hàng Nặng Việt Trì-Phú Thọ",
      journey: [
        { warehouseId: "1327", warehouseName: "Kho KH lớn HCM", arrivedAt: "2026-08-14T09:44:09.000Z", departedAt: "2026-08-21T14:46:30.000Z", current: false },
        { warehouseId: "21652000", warehouseName: "Kho Chuyển Tiếp Phú Thọ 01", arrivedAt: "2026-08-23T18:50:17.000Z", departedAt: "2026-08-23T22:20:05.000Z", current: false },
        { warehouseId: "21160000", warehouseName: "Kho Giao Hàng Nặng Việt Trì-Phú Thọ", arrivedAt: "2026-08-24T14:59:57.000Z", current: true },
      ],
    }));
    expect(diagnosis.findings.map((item) => item.code)).toEqual(["KEY_ACCOUNT_WAREHOUSE_LONG_DWELL", "MORNING_COT_LATE_GHN_INTAKE", "GHN_MISSED_0700_COT"]);
  });

  it("keeps the pickup root cause after an order has progressed to delivery", () => {
    const diagnosis = diagnoseOperationalJourney(tracking({
      status: "delivering", statusLabel: "Đang giao hàng", phase: "DELIVERING",
      orderCreatedAt: "2026-08-20T00:00:00.000Z", endPickAt: "2026-08-22T02:00:00.000Z", pickWarehouseId: "1327",
      journey: [{ warehouseId: "1327", warehouseName: "Kho KH lớn HCM", arrivedAt: "2026-08-21T00:00:00.000Z", departedAt: "2026-08-21T08:00:00.000Z", current: false }],
    }));
    expect(diagnosis.findings).toHaveLength(1);
    expect(diagnosis.findings[0]).toMatchObject({ code: "PICKUP_COMPLETION_DELAY", ownerWarehouseId: "1327" });
  });

  it("keeps a historical root cause when the final warehouse starts delivery after its applicable COT", () => {
    const diagnosis = diagnoseOperationalJourney(tracking({
      status: "delivered", statusLabel: "Đã giao hàng", phase: "COMPLETED",
      deliverWarehouseId: "21160000", deliveryStartedAt: "2026-08-25T01:00:00.000Z", endSuccessAt: "2026-08-25T06:12:05.000Z",
      journey: [{ warehouseId: "21160000", warehouseName: "Kho Giao Hàng Nặng Việt Trì-Phú Thọ", arrivedAt: "2026-08-22T00:57:48.000Z", current: false }],
    }));
    expect(diagnosis.findings).toHaveLength(1);
    expect(diagnosis.findings[0]).toMatchObject({ code: "FINAL_WAREHOUSE_LATE_DELIVERY_START", ownerWarehouseId: "21160000" });
  });

  it("groups the missed morning intake and late delivery assignment at the destination GHN warehouse", () => {
    const diagnosis = diagnoseOperationalJourney(tracking({
      status: "delivering", statusLabel: "Đang giao hàng", phase: "DELIVERING",
      currentWarehouseId: "21160000", currentWarehouseName: "Kho Giao Hàng Nặng Việt Trì-Phú Thọ",
      deliveryStartedAt: "2026-08-25T02:52:53.000Z",
      journey: [
        { warehouseId: "21652000", warehouseName: "Kho Chuyển Tiếp Phú Thọ 01", arrivedAt: "2026-08-22T19:53:50.000Z", current: false },
        { warehouseId: "21160000", warehouseName: "Kho Giao Hàng Nặng Việt Trì-Phú Thọ", arrivedAt: "2026-08-23T06:11:54.000Z", current: true },
      ],
    }));
    expect(diagnosis.findings.map((item) => item.code)).toEqual(["MORNING_COT_LATE_GHN_INTAKE", "FINAL_WAREHOUSE_LATE_DELIVERY_START"]);
    expect(new Set(diagnosis.findings.map((item) => item.ownerWarehouseId))).toEqual(new Set(["21160000"]));
  });

  it("groups same order type, customer, warehouse responsibility and failure pattern", () => {
    const base = tracking({ currentWarehouseId: "21652000", currentWarehouseName: "Kho Chuyển Tiếp Phú Thọ 01", journey: [{ warehouseId: "21652000", warehouseName: "Kho Chuyển Tiếp Phú Thọ 01", arrivedAt: "2026-08-23T04:00:00.000Z", current: true }] });
    const groups = groupOperationalDiagnoses([diagnoseOperationalJourney({ ...base, orderCode: "ORDER_A" }), diagnoseOperationalJourney({ ...base, orderCode: "ORDER_B" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].orderCodes).toEqual(["ORDER_A", "ORDER_B"]);
  });
});
