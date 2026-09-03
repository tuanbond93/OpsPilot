import { describe, expect, it } from "vitest";
import { parseLatestOperationalEvidence } from "@/services/ghn-lastmile-operational-evidence";

const freshRow = {
  hub_id: "21160000",
  source_fetched_at: "2026-08-29T05:55:59.701Z",
  staffing: {
    hubId: "21160000", scheduleDate: "2026-08-29", scheduledForDayCount: 22,
    currentlyScheduledWorkforceCount: 22, onLeaveCount: 0, activeDriverCount: 9,
    scheduledActiveDriverCount: 9, unscheduledActiveDriverCount: 0,
  },
  workload: {
    hubId: "21160000", activeTripCount: 9, activeDriverCount: 9,
    assignedDeliveryCount: 292, successfulDeliveryCount: 74, pendingDeliveryCount: 218,
    returnCount: 0, cancelledCount: 0, latestSourceUpdatedAt: "2026-08-29T05:55:59.701Z",
  },
};

describe("GHN operational evidence loader", () => {
  it("accepts a fresh snapshot only when the incident warehouse exactly matches the hub", () => {
    const evidence = parseLatestOperationalEvidence(freshRow, "21160000", Date.parse("2026-08-29T06:00:00Z"));
    expect(evidence?.warehouseId).toBe("21160000");
    expect(evidence?.staffing?.currentlyScheduledWorkforceCount).toBe(22);
    expect(evidence?.workload?.pendingDeliveryCount).toBe(218);
  });

  it("rejects stale or mismatched snapshots", () => {
    expect(parseLatestOperationalEvidence(freshRow, "21158000", Date.parse("2026-08-29T06:00:00Z"))).toBeNull();
    expect(parseLatestOperationalEvidence(freshRow, "21160000", Date.parse("2026-08-29T06:30:00Z"))).toBeNull();
  });
});
