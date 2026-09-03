import { describe, expect, it } from "vitest";
import { collectFinishedTrips, collectTripItems } from "@/connectors/ghn-lastmile";

describe("GHN Lastmile pagination", () => {
  it("walks every finished-trip page and filters the requested hub", async () => {
    const payloads: Record<string, unknown>[] = [];
    const result = await collectFinishedTrips({
      hubId: "21160000", pageSize: 2,
      request: async (payload) => {
        payloads.push(payload);
        const page = Number(payload.page);
        return { total: 3, data: page === 1
          ? [{ tripCode: "a", status: "FINISHED", hubId: "21160000" }, { tripCode: "b", status: "FINISHED", hubId: "other" }]
          : [{ tripCode: "c", status: "FINISHED", hubId: "21160000" }] };
      },
    });
    expect(result.map((trip) => trip.tripCode)).toEqual(["a", "c"]);
    expect(payloads).toHaveLength(2);
    expect(payloads[1].offset).toBe(2);
  });

  it("walks item pages until total is reached", async () => {
    const payloads: Record<string, unknown>[] = [];
    const result = await collectTripItems({
      tripCode: "trip-1", pageSize: 2,
      request: async (payload) => {
        payloads.push(payload);
        return Number(payload.offset) === 0
          ? { total: 3, data: [{ tripCode: "trip-1", orderCode: "x", type: "DELIVER", isSucceeded: true }, { tripCode: "other", orderCode: "y", type: "DELIVER", isSucceeded: true }] }
          : { total: 3, data: [{ tripCode: "trip-1", orderCode: "z", type: "DELIVER", isSucceeded: false }] };
      },
    });
    expect(result.map((item) => item.orderCode)).toEqual(["x", "z"]);
    expect(payloads).toHaveLength(2);
  });
});
