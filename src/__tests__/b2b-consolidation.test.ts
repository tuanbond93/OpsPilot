import { describe, expect, it } from "vitest";
import { analyzeB2bConsolidation } from "@/domain/b2b-consolidation";

const trip = { tripId: "B2B-TRIP-01", originWarehouse: "Kho A", destinationWarehouse: "Bưu cục B", departureAt: "2026-08-28T10:00:00.000Z", capacityKg: 1000, bookedKg: 100, capacityM3: 10, bookedM3: 1 };
const orders = [
  { orderCode: "B2B-001", readyAt: "2026-08-28T08:00:00.000Z", latestSafeDepartureAt: "2026-08-28T11:00:00.000Z", weightKg: 100, volumeM3: 1 },
  { orderCode: "B2B-002", readyAt: "2026-08-28T08:00:00.000Z", latestSafeDepartureAt: "2026-08-28T11:30:00.000Z", weightKg: 120, volumeM3: 1 },
];

describe("B2B consolidation shadow advisor", () => {
  it("allows an eligible option only as a manager-approved shadow proposal", () => {
    const result = analyzeB2bConsolidation({ trip, orders });
    expect(result.verdict).toBe("ELIGIBLE_SHADOW");
    expect(result.options.find((option) => option.option === "HOLD_FOR_CONSOLIDATION")).toMatchObject({ enabled: true, approvalRequired: true });
    expect(result.financialImpact).toEqual({ status: "NOT_EVALUATED", authority: "P15-B.1" });
  });

  it("requires human investigation when capacity is unavailable", () => {
    const result = analyzeB2bConsolidation({ trip: { ...trip, capacityKg: null, bookedKg: null, capacityM3: null, bookedM3: null }, orders });
    expect(result.verdict).toBe("HUMAN_INVESTIGATION_REQUIRED");
    expect(result.reasonCodes).toContain("CAPACITY_DATA_MISSING");
  });

  it("recommends dispatch now if waiting misses the safe departure", () => {
    const result = analyzeB2bConsolidation({ trip: { ...trip, departureAt: "2026-08-28T12:00:00.000Z" }, orders });
    expect(result.verdict).toBe("DISPATCH_NOW");
    expect(result.reasonCodes).toContain("SLA_WINDOW_WOULD_BE_BREACHED");
  });

  it("does not claim a consolidation benefit for one order", () => {
    const result = analyzeB2bConsolidation({ trip, orders: [orders[0]] });
    expect(result.verdict).toBe("HUMAN_INVESTIGATION_REQUIRED");
    expect(result.reasonCodes).toContain("SINGLE_ORDER_NO_CONSOLIDATION_BENEFIT");
  });
});
