import { describe, expect, it } from "vitest";
import { buildScheduledStaffingSnapshot } from "@/connectors/ghn-lastmile";

describe("GHN Lastmile scheduled staffing projection", () => {
  it("counts a scheduled workforce and checks active drivers without exposing staff details", () => {
    const snapshot = buildScheduledStaffingSnapshot({
      hubId: "21158000",
      weekdays: [{ date: "2026-08-29T00:00:00+07:00", value: "T7 29/08" }],
      users: [
        { userId: "driver-a", schedules: [{ dateLabel: "T7 29/08", shifts: [{ startAt: "07:00", endAt: "22:00", isOnLeave: false }] }] },
        { userId: "driver-b", schedules: [{ dateLabel: "T7 29/08", shifts: [{ startAt: "07:00", endAt: "22:00", isOnLeave: false }] }] },
        { userId: "scheduled-other", schedules: [{ dateLabel: "T7 29/08", shifts: [{ startAt: "07:00", endAt: "15:00", isOnLeave: false }] }] },
        { userId: "on-leave", schedules: [{ dateLabel: "T7 29/08", shifts: [{ startAt: "07:00", endAt: "22:00", isOnLeave: true }] }] },
      ],
      activeDriverIds: ["driver-a", "driver-b", "driver-missing"],
      at: "2026-08-29T03:00:00Z",
      sourceFetchedAt: "2026-08-29T03:01:00Z",
    });

    expect(snapshot).toEqual({
      hubId: "21158000", scheduleDate: "2026-08-29",
      scheduledForDayCount: 3, currentlyScheduledWorkforceCount: 3, onLeaveCount: 1,
      activeDriverCount: 3, scheduledActiveDriverCount: 2, unscheduledActiveDriverCount: 1,
      sourceFetchedAt: "2026-08-29T03:01:00Z",
    });
    expect(JSON.stringify(snapshot)).not.toContain("driver-a");
  });
});
