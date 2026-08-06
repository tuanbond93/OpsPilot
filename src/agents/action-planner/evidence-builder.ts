import type { IncidentRow, IncidentHistoryRow, OrderExceptionRow, FollowupCaseRow } from "@/connectors/supabase";
import type { RootCauseResult } from "../root-cause/schema";

export interface EvidenceItem {
  code: string;
  statement: string;
}

export interface BuildEvidenceResult {
  evidenceList: EvidenceItem[];
  allowedEvidenceCodes: string[];
  missingData: string[];
}

export function buildPlannerEvidence(
  incident: IncidentRow,
  historyRows: IncidentHistoryRow[] = [],
  rootCauseResult?: RootCauseResult | null,
  followupCase?: FollowupCaseRow | null,
  exceptions: OrderExceptionRow[] = []
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

  // Known missing data vectors
  missingData.push("NO_STAFFING_DATA");
  missingData.push("NO_VEHICLE_GPS_DATA");
  missingData.push("NO_ROUTE_CAPACITY_DATA");

  evidenceMap.set("NO_STAFFING_DATA", "Hệ thống chưa kết nối dữ liệu danh sách ca trực và nhân sự kho.");
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
