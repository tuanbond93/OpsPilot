import type { LiveOrderTracking } from "@/connectors/ghn-order-tracking";

export const OPERATIONAL_PLAYBOOK_VERSION = "2026-08-27.1";
export const GHN_MORNING_COT_HOUR = 7;

export type OperationalFinding = {
  code: string;
  groupingKey?: string;
  ownerWarehouseId: string;
  ownerWarehouseName: string;
  severity: "high" | "medium";
  title: string;
  evidence: string;
  action: string;
};

export type OperationalDiagnosis = {
  orderCode: string;
  orderType: "DOCUMENT_RETURN_CPTT" | "STANDARD";
  customerId: string | null;
  customerName: string;
  groupKey: string;
  findings: OperationalFinding[];
};

const hours = (start: string, end: string) => Math.round(((Date.parse(end) - Date.parse(start)) / 3_600_000) * 10) / 10;
const isGhnWarehouse = (name: string) => /giao hàng nặng|kho ghn/i.test(name);
const isPostOffice = (name: string | null) => /bưu cục|buu cuc/i.test(name || "");
const isTransitWarehouse = (name: string) => /chuyển tiếp|trung chuyển/i.test(name);
const isLargeTransitWarehouse = (name: string) => /trung chuyển|\bhub\b/i.test(name);
const isLargeCustomerWarehouse = (name: string) => /kh lớn|khl|key account/i.test(name);
const viTime = (value: string) => new Date(value).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
const localDate = (value: string | Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
const localHour = (value: string | Date) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", hourCycle: "h23" }).format(new Date(value)));

function nextMorningCot(arrivedAt: string) {
  const arrived = new Date(arrivedAt);
  const localParts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(arrived);
  const value = Object.fromEntries(localParts.map((part) => [part.type, part.value]));
  const localHour = Number(value.hour);
  const base = new Date(`${value.year}-${value.month}-${value.day}T00:00:00+07:00`);
  if (localHour >= GHN_MORNING_COT_HOUR) base.setUTCDate(base.getUTCDate() + 1);
  return new Date(base.getTime() + GHN_MORNING_COT_HOUR * 3_600_000);
}

export function diagnoseOperationalJourney(tracking: LiveOrderTracking, referenceTime = tracking.checkedAt): OperationalDiagnosis {
  const findings: OperationalFinding[] = [];
  const orderType = tracking.orderCode.toUpperCase().endsWith("_CPTT") ? "DOCUMENT_RETURN_CPTT" : "STANDARD";
  const currentTime = new Date(referenceTime);

  if (tracking.orderCreatedAt && tracking.endPickAt && hours(tracking.orderCreatedAt, tracking.endPickAt) > 24) {
    const pickupWait = hours(tracking.orderCreatedAt, tracking.endPickAt);
    const pickupPoint = tracking.journey.find((point) => point.warehouseId === tracking.pickWarehouseId) || tracking.journey[0];
    findings.push({ code: "PICKUP_COMPLETION_DELAY", ownerWarehouseId: tracking.pickWarehouseId || pickupPoint?.warehouseId || "unknown", ownerWarehouseName: pickupPoint?.warehouseName || "Kho lấy chưa xác định", severity: "high", title: "Khâu lấy hàng hoàn tất chậm quá 24 giờ", evidence: `Từ lúc tạo đơn ${viTime(tracking.orderCreatedAt)} đến khi hoàn tất lấy ${viTime(tracking.endPickAt)} mất ${pickupWait} giờ.`, action: `Kiểm tra tại ${pickupPoint?.warehouseName || "kho lấy"}: nguyên nhân khâu lấy kéo dài ${pickupWait} giờ và điểm nghẽn bàn giao sang tuyến tiếp theo.` });
  }

  tracking.journey.forEach((point, index) => {
    const endAt = point.departedAt || (point.current ? referenceTime : undefined);
    const dwell = endAt ? hours(point.arrivedAt, endAt) : 0;
    const next = tracking.journey[index + 1];

    if (orderType === "DOCUMENT_RETURN_CPTT" && isGhnWarehouse(point.warehouseName) && point.departedAt && dwell >= 24) {
      findings.push({ code: "CPTT_GHN_OUTBOUND_DELAY", ownerWarehouseId: point.warehouseId, ownerWarehouseName: point.warehouseName, severity: "high", title: "Kho GHN chậm xuất chứng từ thu hồi", evidence: `Đơn CPTT lưu tại ${point.warehouseName} ${dwell} giờ, từ ${viTime(point.arrivedAt)} đến ${viTime(point.departedAt)}.`, action: `Kiểm tra việc xuất chứng từ tại ${point.warehouseName}: vì sao chứng từ không được xuất ngay mà lưu ${dwell} giờ.` });
    }
    if (isTransitWarehouse(point.warehouseName) && point.current && currentTime > nextMorningCot(point.arrivedAt)) {
      const missedCot = nextMorningCot(point.arrivedAt);
      const nextName = tracking.nextWarehouseName || "";
      if (isGhnWarehouse(nextName)) {
        findings.push({ code: "TRANSIT_TO_GHN_NOT_EXPORTED", ownerWarehouseId: tracking.nextWarehouseId || point.warehouseId, ownerWarehouseName: nextName, severity: "high", title: "KCT lỡ COT 07:00, chưa xuất sang kho GHN", evidence: `Đơn nhập ${point.warehouseName} lúc ${viTime(point.arrivedAt)}, đã qua COT ${viTime(missedCot.toISOString())} nhưng vẫn lưu kho; đích kế tiếp là ${nextName}.`, action: `${nextName} làm việc lại với ${point.warehouseName}: xác minh vì sao chưa nhận được kiện sau COT 07:00 và yêu cầu KCT xuất sang kho GHN.` });
      } else if (isLargeTransitWarehouse(nextName)) {
        findings.push({ code: "TRANSIT_TO_HUB_NOT_EXPORTED", ownerWarehouseId: point.warehouseId, ownerWarehouseName: point.warehouseName, severity: "high", title: "KCT lỡ COT 07:00, chưa xuất đến kho trung chuyển lớn", evidence: `Đơn nhập ${point.warehouseName} lúc ${viTime(point.arrivedAt)}, đã qua COT ${viTime(missedCot.toISOString())} nhưng vẫn lưu kho; đích kế tiếp là ${nextName}.`, action: `Làm việc trực tiếp với ${point.warehouseName} để xuất ngay đơn sang ${nextName}.` });
      } else {
        findings.push({ code: "TRANSIT_WAREHOUSE_NOT_EXPORTED", ownerWarehouseId: point.warehouseId, ownerWarehouseName: point.warehouseName, severity: "high", title: "KCT lỡ COT 07:00 — chưa xác định đích", evidence: `Đơn nhập ${point.warehouseName} lúc ${viTime(point.arrivedAt)}, đã qua COT ${viTime(missedCot.toISOString())} nhưng vẫn lưu kho; timeline chưa xác định kho kế tiếp.`, action: `Xác minh kho kế tiếp trước khi quy đầu mối: nếu sang hub thì làm việc với KCT; nếu sang kho GHN thì kho GHN làm việc lại với KCT.` });
      }
    }
    if (endAt && isLargeCustomerWarehouse(point.warehouseName) && dwell >= 24) {
      findings.push({ code: "KEY_ACCOUNT_WAREHOUSE_LONG_DWELL", ownerWarehouseId: point.warehouseId, ownerWarehouseName: point.warehouseName, severity: "high", title: "Kho khách hàng lớn om hàng kéo dài", evidence: `Chặng tại ${point.warehouseName} kéo dài ${dwell} giờ.`, action: `Kiểm tra tình hình vận hành tại ${point.warehouseName}: nguyên nhân om hàng ${dwell} giờ trước khi xuất.` });
    }
    if (next && isTransitWarehouse(point.warehouseName) && isGhnWarehouse(next.warehouseName)) {
      const movementReference = point.departedAt || point.arrivedAt;
      const departureLocalHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", hourCycle: "h23" }).format(new Date(movementReference)));
      const arrivalLocalHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", hourCycle: "h23" }).format(new Date(next.arrivedAt)));
      if (departureLocalHour <= GHN_MORNING_COT_HOUR && arrivalLocalHour >= 12 && hours(movementReference, next.arrivedAt) >= 6 && localDate(movementReference) === localDate(next.arrivedAt)) {
        const movementEvidence = point.departedAt
          ? `Hàng xuất ${point.warehouseName} lúc ${viTime(point.departedAt)}`
          : `Đơn đã có mặt tại ${point.warehouseName} lúc ${viTime(point.arrivedAt)} nhưng log chưa có mốc xuất KCT`;
        findings.push({ code: "MORNING_COT_LATE_GHN_INTAKE", ownerWarehouseId: next.warehouseId, ownerWarehouseName: next.warehouseName, severity: "high", title: "Không vào chuyến/COT 07:00 để nhập kho GHN đúng giờ", evidence: `${movementEvidence}; đến ${viTime(next.arrivedAt)} mới nhập ${next.warehouseName}.`, action: `Kiểm tra vì sao đơn không được đưa vào chuyến COT 07:00 ngày ${localDate(next.arrivedAt)} và đến ${viTime(next.arrivedAt)} mới nhập ${next.warehouseName}.` });
      }
    }
    const morningGhnIntakeNotAssigned = isGhnWarehouse(point.warehouseName) && point.current && tracking.status === "storing" && localDate(point.arrivedAt) === localDate(currentTime) && localHour(point.arrivedAt) < 12 && localHour(currentTime) >= 13 && dwell >= 2;
    if (morningGhnIntakeNotAssigned) {
      findings.push({ code: "GHN_MORNING_INTAKE_NOT_ASSIGNED_DELIVERY", ownerWarehouseId: point.warehouseId, ownerWarehouseName: point.warehouseName, severity: "high", title: "Kho GHN chưa gán/xuất giao hàng nhận buổi sáng", evidence: `Đơn nhập ${point.warehouseName} lúc ${viTime(point.arrivedAt)}, sau ${dwell} giờ vẫn ở trạng thái lưu kho, chưa chuyển sang đang giao.`, action: `Kiểm tra với ${point.warehouseName}: vì sao hàng nhận từ KCT buổi sáng chưa được gán giao và xuất giao trong ngày.` });
    }
    const finalPostOffice = tracking.deliverWarehouseId && tracking.deliverWarehouseId !== point.warehouseId && isPostOffice(tracking.deliverWarehouseName);
    if (isGhnWarehouse(point.warehouseName) && point.current && tracking.status === "storing" && !morningGhnIntakeNotAssigned && finalPostOffice && currentTime > nextMorningCot(point.arrivedAt)) {
      const cot = nextMorningCot(point.arrivedAt);
      findings.push({
        code: "GHN_TO_FINAL_POST_OFFICE_NOT_EXPORTED",
        groupingKey: `GHN_TO_FINAL_POST_OFFICE_NOT_EXPORTED:${tracking.deliverWarehouseId}`,
        ownerWarehouseId: point.warehouseId,
        ownerWarehouseName: point.warehouseName,
        severity: "high",
        title: "Kho GHN chưa xuất đơn về bưu cục giao cuối",
        evidence: `Đơn nhập ${point.warehouseName} lúc ${viTime(point.arrivedAt)}; kho giao cuối là ${tracking.deliverWarehouseName}. Đến ${viTime(referenceTime)} vẫn lưu tại ${point.warehouseName}, đã qua COT 07:00 ngày ${viTime(cot.toISOString())} và chưa có log xuất về bưu cục.`,
        action: `Kiểm tra với ${point.warehouseName}: vì sao đơn chưa được xuất về bưu cục ${tracking.deliverWarehouseName} sau COT 07:00; đối soát log đổi kho và chuyến xuất gần nhất.`,
      });
    } else if (isGhnWarehouse(point.warehouseName) && point.current && tracking.status === "storing" && !morningGhnIntakeNotAssigned && currentTime > nextMorningCot(point.arrivedAt)) {
      const cot = nextMorningCot(point.arrivedAt);
      findings.push({ code: "GHN_MISSED_0700_COT", ownerWarehouseId: point.warehouseId, ownerWarehouseName: point.warehouseName, severity: "high", title: "Kho GHN đã lỡ COT 07:00", evidence: `Đơn nhập kho lúc ${viTime(point.arrivedAt)}, đã qua COT 07:00 ngày ${viTime(cot.toISOString())} nhưng chưa xuất giao.`, action: `Kiểm tra với ${point.warehouseName}: vì sao đơn chưa được xuất giao sau COT 07:00.` });
    }
  });

  const finalWarehouse = [...tracking.journey].reverse().find((point) => point.warehouseId === tracking.deliverWarehouseId)
    || (tracking.phase === "DELIVERING" ? [...tracking.journey].reverse().find((point) => isGhnWarehouse(point.warehouseName)) : undefined);
  if (finalWarehouse && tracking.deliveryStartedAt) {
    const deliveryCot = nextMorningCot(finalWarehouse.arrivedAt);
    if (new Date(tracking.deliveryStartedAt) > deliveryCot) {
      const wait = hours(finalWarehouse.arrivedAt, tracking.deliveryStartedAt);
      const sourceNote = tracking.deliveryStartedAtInferred ? " (mốc suy ra từ sự kiện giao mới nhất vì nguồn thiếu log gán shipper riêng)" : "";
      findings.push({ code: "FINAL_WAREHOUSE_LATE_DELIVERY_START", ownerWarehouseId: finalWarehouse.warehouseId, ownerWarehouseName: finalWarehouse.warehouseName, severity: "high", title: "Kho cuối gán/xuất giao sau COT 07:00", evidence: `Đơn nhập ${finalWarehouse.warehouseName} lúc ${viTime(finalWarehouse.arrivedAt)}, đến ${viTime(tracking.deliveryStartedAt)} mới bắt đầu/gán giao${sourceNote}, chậm ${wait} giờ và đã qua COT ${viTime(deliveryCot.toISOString())}.`, action: `Kiểm tra với ${finalWarehouse.warehouseName}: vì sao đến ${viTime(tracking.deliveryStartedAt)} đơn mới được gán/xuất giao thay vì tại COT 07:00 áp dụng.` });
    }
  }

  const codes = [...new Set(findings.map((finding) => finding.groupingKey || finding.code))].sort().join("+") || "NO_RULE_MATCH";
  const ownerIds = [...new Set(findings.map((finding) => finding.ownerWarehouseId))].sort().join("+") || tracking.currentWarehouseId || "unknown";
  return {
    orderCode: tracking.orderCode,
    orderType,
    customerId: tracking.customerId,
    customerName: tracking.customerName || (tracking.customerId ? `Khách hàng ${tracking.customerId}` : "Khách hàng chưa xác định"),
    groupKey: [orderType, tracking.customerId || "unknown", ownerIds, codes].join("|"),
    findings,
  };
}

export function groupOperationalDiagnoses(diagnoses: OperationalDiagnosis[]) {
  const groups = new Map<string, { key: string; orderType: OperationalDiagnosis["orderType"]; customerName: string; orderCodes: string[]; findings: OperationalFinding[] }>();
  for (const diagnosis of diagnoses) {
    const existing = groups.get(diagnosis.groupKey);
    if (existing) existing.orderCodes.push(diagnosis.orderCode);
    else groups.set(diagnosis.groupKey, { key: diagnosis.groupKey, orderType: diagnosis.orderType, customerName: diagnosis.customerName, orderCodes: [diagnosis.orderCode], findings: diagnosis.findings });
  }
  return [...groups.values()].sort((a, b) => b.orderCodes.length - a.orderCodes.length).map((group) => ({ ...group, key: group.orderCodes.slice().sort().join("|") }));
}
