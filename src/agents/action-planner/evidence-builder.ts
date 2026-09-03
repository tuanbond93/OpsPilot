import type { IncidentRow, IncidentHistoryRow, OrderExceptionRow, FollowupCaseRow } from "@/connectors/supabase";
import type { RootCauseResult } from "../root-cause/schema";
import type { ActiveTripWorkloadSnapshot, HistoricalThroughputSnapshot, ScheduledStaffingSnapshot } from "@/connectors/ghn-lastmile";

export interface EvidenceItem {
  code: string;
  statement: string;
}

export interface BuildEvidenceResult {
  evidenceList: EvidenceItem[];
  allowedEvidenceCodes: string[];
  missingData: string[];
}

/**
 * A server-side, privacy-minimised operational projection. `warehouseId` is
 * deliberately explicit because Rillnet warehouse IDs and GHN hub IDs can
 * differ; a snapshot is unusable until the mapping has been verified.
 */
export interface PlannerOperationalEvidence {
  warehouseId: string;
  ghnHubId: string;
  staffing?: ScheduledStaffingSnapshot | null;
  workload?: ActiveTripWorkloadSnapshot | null;
  throughput?: HistoricalThroughputSnapshot | null;
}

const MAX_OPERATIONAL_EVIDENCE_AGE_MS = 30 * 60 * 1000;
const isFreshSnapshot = (sourceFetchedAt: string, referenceTimeMs: number) => {
  const fetchedAt = Date.parse(sourceFetchedAt);
  return !Number.isNaN(fetchedAt) && fetchedAt <= referenceTimeMs && referenceTimeMs - fetchedAt <= MAX_OPERATIONAL_EVIDENCE_AGE_MS;
};

export function buildPlannerEvidence(
  incident: IncidentRow,
  historyRows: IncidentHistoryRow[] = [],
  rootCauseResult?: RootCauseResult | null,
  followupCase?: FollowupCaseRow | null,
  exceptions: OrderExceptionRow[] = [],
  operationalEvidence?: PlannerOperationalEvidence | null,
  referenceTimeMs: number = Date.now()
): BuildEvidenceResult {
  const evidenceMap = new Map<string, string>();
  const missingData: string[] = [];

  // Incident metrics evidence
  const latestHistory = historyRows[0];
  const affectedCount = latestHistory ? latestHistory.affected_order_count : 0;
  evidenceMap.set("CURRENT_AFFECTED_COUNT", `Số đơn hàng ảnh hưởng hiện tại: ${affectedCount} đơn.`);

  if (historyRows.length >= 2) {
    const prevCount = historyRows[1].affected_order_count;
    evidenceMap.set("PREVIOUS_AFFECTED_COUNT", `Số đơn hàng kỳ trước: ${prevCount} đơn.`);
    const change = affectedCount - prevCount;
    evidenceMap.set("COUNT_CHANGE_ABSOLUTE", `Biến động tuyệt đối: ${change > 0 ? "+" : ""}${change} đơn.`);
  } else {
    evidenceMap.set("HISTORY_INSUFFICIENT", "Lịch sử sự cố chưa đủ 2 mốc để tính xu hướng.");
  }

  if (latestHistory?.maximum_age_hours != null) {
    evidenceMap.set("MAXIMUM_AGE_HOURS", `Thời gian tồn lâu nhất: ${latestHistory.maximum_age_hours} giờ.`);
  }

  if (latestHistory?.average_age_hours != null) {
    evidenceMap.set("AVERAGE_AGE_HOURS", `Thời gian tồn trung bình: ${latestHistory.average_age_hours} giờ.`);
  }

  // Root cause evidence if present
  if (rootCauseResult) {
    for (const cause of rootCauseResult.causes) {
      for (const code of cause.evidenceCodes) {
        if (!evidenceMap.has(code)) {
          evidenceMap.set(code, `Bằng chứng nguyên nhân từ Chẩn đoán: ${cause.title} (${code})`);
        }
      }
    }
  }

  // Follow-up state evidence
  if (followupCase) {
    evidenceMap.set(
      "FOLLOWUP_STATE",
      `Trạng thái theo dõi hiện tại: ${followupCase.current_state} (Tiến độ: ${followupCase.current_progress_percent}%)`
    );
  }

  // Exception evidence
  if (exceptions.length > 0) {
    evidenceMap.set(
      "HAS_ACTIVE_EXCEPTIONS",
      `Có ${exceptions.length} ngoại lệ đơn hàng đang hoạt động trong hệ thống.`
    );
  } else {
    evidenceMap.set("NO_ACTIVE_EXCEPTIONS", "Không ghi nhận ngoại lệ đơn hàng nào đang hoạt động.");
  }

  const mappedToIncident = operationalEvidence?.warehouseId === incident.warehouse_id;
  const staffing = mappedToIncident && operationalEvidence?.staffing?.hubId === operationalEvidence.ghnHubId ? operationalEvidence.staffing : null;
  const workload = mappedToIncident && operationalEvidence?.workload?.hubId === operationalEvidence.ghnHubId ? operationalEvidence.workload : null;
  const throughput = mappedToIncident && operationalEvidence?.throughput?.hubId === operationalEvidence.ghnHubId ? operationalEvidence.throughput : null;
  const staffingIsUsable = Boolean(staffing && isFreshSnapshot(staffing.sourceFetchedAt, referenceTimeMs));
  const workloadIsUsable = Boolean(workload && isFreshSnapshot(workload.sourceFetchedAt, referenceTimeMs));
  const throughputIsUsable = Boolean(throughput && throughput.sufficientHubSample && isFreshSnapshot(throughput.sourceFetchedAt, referenceTimeMs));

  if (staffingIsUsable && staffing) {
    evidenceMap.set("SCHEDULED_WORKFORCE", `Nhân sự được xếp ca tại hub: ${staffing.currentlyScheduledWorkforceCount} người (nghỉ phép: ${staffing.onLeaveCount}).`);
    evidenceMap.set("ACTIVE_DRIVER_COUNT", `Tài xế đang có chuyến ON_TRIP: ${staffing.activeDriverCount}; trong lịch ca: ${staffing.scheduledActiveDriverCount}.`);
  } else {
    missingData.push("NO_STAFFING_DATA");
    evidenceMap.set("NO_STAFFING_DATA", "Hệ thống chưa kết nối dữ liệu danh sách ca trực và nhân sự kho.");
  }

  if (workloadIsUsable && workload) {
    evidenceMap.set("ACTIVE_DELIVERY_WORKLOAD", `Chuyến đang chạy: ${workload.activeTripCount}; đơn đã gán: ${workload.assignedDeliveryCount}; đã giao thành công: ${workload.successfulDeliveryCount}; còn lại: ${workload.pendingDeliveryCount}.`);
  }

  if (throughputIsUsable && throughput) {
    evidenceMap.set("HISTORICAL_DELIVERY_THROUGHPUT", `Năng suất giao lịch sử P50/P75: ${throughput.hubP50DeliveriesPerHour}/${throughput.hubP75DeliveriesPerHour} đơn/giờ.`);
    if (throughput.paceRatio != null) {
      evidenceMap.set("DELIVERY_PACE_RATIO", `Tiến độ giao hiện tại so với baseline: ${Math.round(throughput.paceRatio * 100)}%.`);
    }
  }

  // GPS and route/vehicle capacity are still unavailable. Historical delivery
  // throughput is observational evidence, never a substitute for either one.
  missingData.push("NO_VEHICLE_GPS_DATA");
  missingData.push("NO_ROUTE_CAPACITY_DATA");
  evidenceMap.set("NO_VEHICLE_GPS_DATA", "Hệ thống chưa có dữ liệu vị trí GPS của phương tiện vận chuyển.");
  evidenceMap.set("NO_ROUTE_CAPACITY_DATA", "Hệ thống chưa có dữ liệu năng lực và giới hạn tải theo tuyến đường.");

  const evidenceList: EvidenceItem[] = Array.from(evidenceMap.entries()).map(([code, statement]) => ({
    code,
    statement,
  }));

  const allowedEvidenceCodes = Array.from(evidenceMap.keys());

  return {
    evidenceList,
    allowedEvidenceCodes,
    missingData,
  };
}
