import { describe, expect, it } from "vitest";
import { buildActiveTripWorkloadSnapshot } from "@/connectors/ghn-lastmile";

describe("GHN Lastmile active-trip workload projection", () => {
  it("counts successful delivery work without retaining raw order details", () => {
    const snapshot = buildActiveTripWorkloadSnapshot("21158000", [
      { tripCode: "trip-1", status: "ON_TRIP", hubId: "21158000", driverId: "driver-a", deliverCount: 43, lastUpdatedTime: "2026-08-29T02:23:40Z" },
      { tripCode: "trip-2", status: "ON_TRIP", hubId: "21158000", driverId: "driver-b", deliverCount: 38, lastUpdatedTime: "2026-08-29T01:45:04Z" },
      { tripCode: "old", status: "FINISHED", hubId: "21158000", driverId: "driver-c", deliverCount: 12 },
    ], [
      { tripCode: "trip-1", orderCode: "order-1", type: "DELIVER", isSucceeded: true, lastUpdatedTime: "2026-08-29T02:50:01Z" },
      { tripCode: "trip-1", orderCode: "order-1", type: "DELIVER", isSucceeded: true },
      { tripCode: "trip-1", orderCode: "order-2", type: "DELIVER", isSucceeded: false },
      { tripCode: "trip-1", orderCode: "order-3", type: "PICK", isSucceeded: true },
      { tripCode: "trip-2", orderCode: "order-4", type: "DELIVER", isSucceeded: false, isCancel: true },
      { tripCode: "old", orderCode: "order-5", type: "DELIVER", isSucceeded: true },
    ], "2026-08-29T03:00:00Z");

    expect(snapshot).toEqual({
      hubId: "21158000", activeTripCount: 2, activeDriverCount: 2,
      assignedDeliveryCount: 81, successfulDeliveryCount: 1, pendingDeliveryCount: 80,
      returnCount: 0, cancelledCount: 1,
      latestSourceUpdatedAt: "2026-08-29T02:50:01Z", sourceFetchedAt: "2026-08-29T03:00:00Z",
    });
    expect(JSON.stringify(snapshot)).not.toContain("order-");
  });
});
