import { describe, it, expect } from "vitest";
import { generateIncidentKey, aggregateIncidents, type Incident } from "../engine/incident";
import type { NormalizedRillnetOrder } from "../connectors/rillnet";

function createDummyOrder(
  id: string,
  orderCode: string,
  warehouseId: string,
  status: string,
  createdAt: string
): NormalizedRillnetOrder {
  return {
    id,
    orderCode,
    status,
    taskCategory: "Tồn KCT/KTC",
    warehouseId,
    warehouseName: `Kho ${warehouseId}`,
    customerId: "cust-1",
    customerName: "Customer 1",
    customerCode: "C1",
    createdAt,
    fetchedAt: new Date().toISOString(),
  };
}

describe("Sprint 3: Event Store & Operational Memory Tests", () => {
  it("generates stable incident keys in format warehouseId:reasonCode", () => {
    const key1 = generateIncidentKey("21160000", "KHO_TON");
    const key2 = generateIncidentKey("21160000", "KHO_TON");
    expect(key1).toBe("21160000:KHO_TON");
    expect(key1).toBe(key2);
  });

  it("limits sample order codes to a maximum of 5", () => {
    const orders: NormalizedRillnetOrder[] = Array.from({ length: 15 }, (_, i) =>
      createDummyOrder(
        `ord-${i}`,
        `CODE-${i}`,
        "21160000",
        "storing",
        new Date(Date.now() - 10 * 3600 * 1000).toISOString()
      )
    );

    const incidents = aggregateIncidents(orders);
    expect(incidents.length).toBe(1);
    expect(incidents[0].affectedOrderCount).toBe(15);
    expect(incidents[0].affectedOrders?.length).toBe(15);
    expect(incidents[0].sampleOrderCodes.length).toBe(5);
    expect(incidents[0].sampleOrderCodes).toEqual([
      "CODE-0",
      "CODE-1",
      "CODE-2",
      "CODE-3",
      "CODE-4",
    ]);
  });

  it("calculates average and maximum age hours accurately", () => {
    const now = Date.now();
    const orders: NormalizedRillnetOrder[] = [
      createDummyOrder("1", "O1", "WH1", "storing", new Date(now - 10 * 3600 * 1000).toISOString()),
      createDummyOrder("2", "O2", "WH1", "storing", new Date(now - 20 * 3600 * 1000).toISOString()),
      createDummyOrder("3", "O3", "WH1", "storing", new Date(now - 30 * 3600 * 1000).toISOString()),
    ];

    const incidents = aggregateIncidents(orders, undefined, now);
    expect(incidents.length).toBe(1);
    expect(incidents[0].averageAgeHours).toBe(20);
    expect(incidents[0].maximumAgeHours).toBe(30);
    expect(incidents[0].oldestOrderCode).toBe("O3");
  });

  it("Scenario 4: excludes orders with active exception", () => {
    const orders: NormalizedRillnetOrder[] = [
      createDummyOrder("1", "EX-ORD-1", "WH1", "storing", new Date().toISOString()),
      createDummyOrder("2", "NORMAL-ORD-2", "WH1", "storing", new Date().toISOString()),
    ];

    const activeExceptions = new Set(["EX-ORD-1"]);
    const incidents = aggregateIncidents(orders, undefined, Date.now(), activeExceptions);

    expect(incidents.length).toBe(1);
    expect(incidents[0].affectedOrderCount).toBe(1);
    expect(incidents[0].sampleOrderCodes).toEqual(["NORMAL-ORD-2"]);
  });

  it("Scenario 5: includes orders when exception is expired / not in active set", () => {
    const orders: NormalizedRillnetOrder[] = [
      createDummyOrder("1", "EX-ORD-1", "WH1", "storing", new Date().toISOString()),
    ];

    // Expired exception -> Set does not contain EX-ORD-1
    const activeExceptions = new Set<string>();
    const incidents = aggregateIncidents(orders, undefined, Date.now(), activeExceptions);

    expect(incidents.length).toBe(1);
    expect(incidents[0].affectedOrderCount).toBe(1);
    expect(incidents[0].sampleOrderCodes).toEqual(["EX-ORD-1"]);
  });

  it("Scenario 1, 2 & 3: Incident Lifecycle Scenarios", () => {
    const refTime0800 = new Date("2026-08-05T08:00:00Z").getTime();
    const refTime1000 = new Date("2026-08-05T10:00:00Z").getTime();

    // Scenario 1: 08:00 warehouse PT has 100 storing orders
    const orders0800 = Array.from({ length: 100 }, (_, i) =>
      createDummyOrder(
        `pt-${i}`,
        `PT-ORD-${i}`,
        "PT",
        "storing",
        new Date(refTime0800 - 5 * 3600 * 1000).toISOString()
      )
    );

    const incidents0800 = aggregateIncidents(orders0800, undefined, refTime0800);
    expect(incidents0800.length).toBe(1);
    expect(incidents0800[0].incidentKey).toBe("PT:KHO_TON");
    expect(incidents0800[0].affectedOrderCount).toBe(100);
    const firstDetected0800 = incidents0800[0].firstDetectedAt;

    // Scenario 2: 10:00 warehouse PT has 72 storing orders
    const orders1000 = Array.from({ length: 72 }, (_, i) =>
      createDummyOrder(
        `pt-${i}`,
        `PT-ORD-${i}`,
        "PT",
        "storing",
        new Date(refTime0800 - 5 * 3600 * 1000).toISOString()
      )
    );

    const incidents1000 = aggregateIncidents(orders1000, undefined, refTime1000);
    expect(incidents1000.length).toBe(1);
    expect(incidents1000[0].incidentKey).toBe("PT:KHO_TON");
    expect(incidents1000[0].affectedOrderCount).toBe(72);
    expect(incidents1000[0].firstDetectedAt).toBe(firstDetected0800);

    // Scenario 3: 12:00 incident disappears
    const orders1200: NormalizedRillnetOrder[] = [];
    const incidents1200 = aggregateIncidents(orders1200, undefined, refTime1000);
    expect(incidents1200.length).toBe(0);
  });
});
