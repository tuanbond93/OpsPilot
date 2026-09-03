import { describe, expect, it } from "vitest";
import { buildPlannerEvidence } from "@/agents/action-planner/evidence-builder";
import type { IncidentRow } from "@/connectors/supabase";

const incident: IncidentRow = {
  id: "incident-1", incident_key: "21158000:KHO_TON", warehouse_id: "21158000", warehouse_name: "Hub pilot",
  reason_code: "KHO_TON", reason_name: "Tồn kho", status: "open", priority_score: 70,
  first_detected_at: "2026-08-29T02:00:00Z", last_detected_at: "2026-08-29T03:00:00Z",
};

describe("planner operational evidence", () => {
  it("uses mapped fresh staffing and throughput but retains GPS and route-capacity limitations", () => {
    const evidence = buildPlannerEvidence(incident, [], null, null, [], {
      warehouseId: "21158000",
      ghnHubId: "21158000",
      staffing: { hubId: "21158000", scheduleDate: "2026-08-29", scheduledForDayCount: 5, currentlyScheduledWorkforceCount: 4, onLeaveCount: 1, activeDriverCount: 2, scheduledActiveDriverCount: 2, unscheduledActiveDriverCount: 0, sourceFetchedAt: "2026-08-29T03:00:00Z" },
      workload: { hubId: "21158000", activeTripCount: 2, activeDriverCount: 2, assignedDeliveryCount: 81, successfulDeliveryCount: 1, pendingDeliveryCount: 80, returnCount: 0, cancelledCount: 0, latestSourceUpdatedAt: "2026-08-29T03:00:00Z", sourceFetchedAt: "2026-08-29T03:00:00Z" },
      throughput: { hubId: "21158000", completedTripSampleCount: 12, sampledDriverCount: 3, sufficientHubSample: true, hubP50DeliveriesPerHour: 2, hubP75DeliveriesPerHour: 3, activeTripCount: 2, expectedSuccessfulDeliveryCount: 4, observedSuccessfulDeliveryCount: 1, paceRatio: 0.25, sourceFetchedAt: "2026-08-29T03:00:00Z" },
    }, Date.parse("2026-08-29T03:10:00Z"));

    expect(evidence.missingData).not.toContain("NO_STAFFING_DATA");
    expect(evidence.missingData).toEqual(["NO_VEHICLE_GPS_DATA", "NO_ROUTE_CAPACITY_DATA"]);
    expect(evidence.allowedEvidenceCodes).toEqual(expect.arrayContaining(["SCHEDULED_WORKFORCE", "ACTIVE_DELIVERY_WORKLOAD", "HISTORICAL_DELIVERY_THROUGHPUT", "DELIVERY_PACE_RATIO"]));
  });

  it("does not trust an unmapped or stale snapshot", () => {
    const evidence = buildPlannerEvidence(incident, [], null, null, [], {
      warehouseId: "different-hub",
      ghnHubId: "different-hub",
      staffing: { hubId: "different-hub", scheduleDate: "2026-08-29", scheduledForDayCount: 5, currentlyScheduledWorkforceCount: 4, onLeaveCount: 1, activeDriverCount: 2, scheduledActiveDriverCount: 2, unscheduledActiveDriverCount: 0, sourceFetchedAt: "2026-08-29T03:00:00Z" },
    }, Date.parse("2026-08-29T04:00:00Z"));

    expect(evidence.missingData).toContain("NO_STAFFING_DATA");
    expect(evidence.allowedEvidenceCodes).not.toContain("SCHEDULED_WORKFORCE");
  });

  it("does not accept a snapshot from a different GHN hub", () => {
    const evidence = buildPlannerEvidence(incident, [], null, null, [], {
      warehouseId: "21158000",
      ghnHubId: "21158000",
      staffing: { hubId: "another-hub", scheduleDate: "2026-08-29", scheduledForDayCount: 5, currentlyScheduledWorkforceCount: 4, onLeaveCount: 1, activeDriverCount: 2, scheduledActiveDriverCount: 2, unscheduledActiveDriverCount: 0, sourceFetchedAt: "2026-08-29T03:00:00Z" },
    }, Date.parse("2026-08-29T03:10:00Z"));

    expect(evidence.missingData).toContain("NO_STAFFING_DATA");
  });
});
