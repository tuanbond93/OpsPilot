import { describe, expect, it } from "vitest";
import { buildHistoricalThroughputSnapshot } from "@/connectors/ghn-lastmile";

describe("GHN Lastmile historical throughput projection", () => {
  it("uses completed delivery pace as a bounded hub-level observation", () => {
    const completedTrips = [1, 2, 3, 4].map((count) => ({
      tripCode: `done-${count}`, status: "FINISHED", hubId: "21158000", driverId: count < 4 ? "driver-a" : "driver-b",
      startTime: "2026-08-20T00:00:00Z", endTime: "2026-08-20T02:00:00Z",
    }));
    const completedTripItems = completedTrips.flatMap((trip, index) => Array.from({ length: (index + 1) * 2 }, (_, item) => ({
      tripCode: trip.tripCode, orderCode: `${trip.tripCode}-order-${item}`, type: "DELIVER" as const, isSucceeded: true,
    })));
    const snapshot = buildHistoricalThroughputSnapshot({
      hubId: "21158000", completedTrips, completedTripItems,
      activeTrips: [{ tripCode: "active-1", status: "ON_TRIP", hubId: "21158000", driverId: "driver-a", deliverCount: 20, startTime: "2026-08-29T00:00:00Z" }],
      activeTripItems: [{ tripCode: "active-1", orderCode: "active-order", type: "DELIVER", isSucceeded: true }],
      at: "2026-08-29T02:00:00Z", sourceFetchedAt: "2026-08-29T02:01:00Z", minimumHubTripSample: 4, minimumDriverTripSample: 3,
    });

    expect(snapshot).toEqual({
      hubId: "21158000", completedTripSampleCount: 4, sampledDriverCount: 2, sufficientHubSample: true,
      hubP50DeliveriesPerHour: 2, hubP75DeliveriesPerHour: 3, activeTripCount: 1,
      expectedSuccessfulDeliveryCount: 4, observedSuccessfulDeliveryCount: 1, paceRatio: 0.25,
      sourceFetchedAt: "2026-08-29T02:01:00Z",
    });
    expect(JSON.stringify(snapshot)).not.toContain("order-");
    expect(JSON.stringify(snapshot)).not.toContain("driver-a");
  });

  it("refuses to estimate pace when the historical sample is too small", () => {
    const snapshot = buildHistoricalThroughputSnapshot({
      hubId: "21158000", completedTrips: [], completedTripItems: [], activeTrips: [], activeTripItems: [],
      at: "2026-08-29T02:00:00Z", sourceFetchedAt: "2026-08-29T02:01:00Z",
    });
    expect(snapshot.hubP50DeliveriesPerHour).toBeNull();
    expect(snapshot.expectedSuccessfulDeliveryCount).toBeNull();
    expect(snapshot.paceRatio).toBeNull();
  });
});
