export interface WarehouseOption {
  id: string;
  name: string;
  suppliers: string[];
}

export const PILOT_WAREHOUSES: WarehouseOption[] = [
  {
    id: "21161000",
    name: "Kho Yên Bái",
    suppliers: ["Hoàng Minh"],
  },
  {
    id: "21158000",
    name: "Kho Lào Cai",
    suppliers: ["Thuận Phát", "Hoàng Minh"],
  },
  {
    id: "21160000",
    name: "Kho Giao Hàng Nặng - Việt Trì - Phú Thọ",
    suppliers: ["Thiên Phú", "Hoàng Minh"],
  },
];

export const GOVERNED_VEHICLE_CLASS = "TRUCK_1_9T";
export const GOVERNED_USABLE_PAYLOAD_KG = 1600;

export interface VehicleAvailabilityFormInput {
  warehouse_id: string;
  supplier_name: string;
  vehicle_class: string;
  available_count: number | string;
  earliest_available_at: string;
  valid_until: string;
}

export interface CapacityPreview {
  usablePayloadKg: number;
  plannedCapacityKg: number | null;
  label: string;
  disclaimer: string;
  displayText: string;
}

export function calculateCapacityPreview(
  countInput: number | string,
  vehicleClass: string = GOVERNED_VEHICLE_CLASS
): CapacityPreview {
  const count = Number(countInput);
  const isValidCount = Number.isInteger(count) && count > 0;
  const unitPayload = vehicleClass === GOVERNED_VEHICLE_CLASS ? GOVERNED_USABLE_PAYLOAD_KG : 1600;
  const plannedCapacityKg = isValidCount ? count * unitPayload : null;

  return {
    usablePayloadKg: unitPayload,
    plannedCapacityKg,
    label: "Năng lực xe đang được xác nhận",
    disclaimer:
      "Đây là năng lực phương tiện được xác nhận; không phải cam kết SLA, công suất bốc xếp hay ước tính tiết kiệm chi phí.",
    displayText: isValidCount
      ? `${count} xe × ${unitPayload.toLocaleString("vi-VN")} kg = ${plannedCapacityKg?.toLocaleString("vi-VN")} kg tải trọng khả dụng dự kiến`
      : "Chưa nhập số xe hợp lệ",
  };
}

export interface FormValidationResult {
  valid: boolean;
  errors: Partial<Record<keyof VehicleAvailabilityFormInput, string>>;
}

export function validateVehicleAvailabilityForm(
  form: Partial<VehicleAvailabilityFormInput>,
  currentTimeMs: number = Date.now()
): FormValidationResult {
  const errors: Partial<Record<keyof VehicleAvailabilityFormInput, string>> = {};

  // 1. Warehouse ID
  if (!form.warehouse_id || !PILOT_WAREHOUSES.some((w) => w.id === form.warehouse_id)) {
    errors.warehouse_id = "Vui lòng chọn một kho hợp lệ trong phạm vi pilot.";
  }

  // 2. Supplier Name
  const selectedWarehouse = PILOT_WAREHOUSES.find((w) => w.id === form.warehouse_id);
  if (!form.supplier_name || !selectedWarehouse?.suppliers.includes(form.supplier_name)) {
    errors.supplier_name = "Vui lòng chọn nhà cung cấp được ủy quyền cho kho này.";
  }

  // 3. Vehicle Class
  if (form.vehicle_class !== GOVERNED_VEHICLE_CLASS) {
    errors.vehicle_class = `Chỉ chấp nhận loại xe định mức ${GOVERNED_VEHICLE_CLASS}.`;
  }

  // 4. Available Count
  const count = Number(form.available_count);
  if (!Number.isInteger(count) || count <= 0) {
    errors.available_count = "Số lượng xe phải là số nguyên dương (>= 1).";
  }

  // 5. Earliest Available At
  let earliestMs = 0;
  if (!form.earliest_available_at) {
    errors.earliest_available_at = "Vui lòng nhập thời điểm xe bắt đầu khả dụng.";
  } else {
    earliestMs = new Date(form.earliest_available_at).getTime();
    if (isNaN(earliestMs)) {
      errors.earliest_available_at = "Thời điểm bắt đầu khả dụng không hợp lệ.";
    }
  }

  // 6. Valid Until
  if (!form.valid_until) {
    errors.valid_until = "Vui lòng nhập thời gian hết hạn (valid_until). Không được để trống.";
  } else {
    const validUntilMs = new Date(form.valid_until).getTime();
    if (isNaN(validUntilMs)) {
      errors.valid_until = "Thời gian hết hạn không hợp lệ.";
    } else if (validUntilMs <= currentTimeMs) {
      errors.valid_until = "Thời gian hết hạn phải lớn hơn thời điểm hiện tại (không ghi nhận fact đã hết hạn).";
    } else if (earliestMs && validUntilMs < earliestMs) {
      errors.valid_until = "Thời gian hết hạn không được sớm hơn thời điểm xe bắt đầu khả dụng.";
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

export function buildSubmissionPayload(form: VehicleAvailabilityFormInput) {
  return {
    warehouse_id: form.warehouse_id,
    supplier_name: form.supplier_name,
    vehicle_class: form.vehicle_class,
    available_count: Number(form.available_count),
    earliest_available_at: new Date(form.earliest_available_at).toISOString(),
    valid_until: new Date(form.valid_until).toISOString(),
  };
}

export function isManagerAuthorized(role?: string, operationalRole?: string): boolean {
  const normalizedRole = (role || "").toUpperCase();
  const normalizedOperationalRole = (operationalRole || "").toUpperCase();

  return (
    normalizedRole === "MANAGER" ||
    normalizedRole === "ADMIN" ||
    normalizedOperationalRole === "OPERATIONS_MANAGER" ||
    normalizedOperationalRole === "DISPATCH_MANAGER" ||
    normalizedRole === "OPERATIONS_MANAGER"
  );
}

export interface SanitizedConfirmation {
  warehouseId: string;
  warehouseName: string;
  supplierName: string;
  vehicleClass: string;
  availableCount: number;
  plannedCapacityKg: number;
  earliestAvailableAt: string;
  validUntil: string;
  status: "AVAILABLE_NOW" | "SCHEDULED_AVAILABLE";
  safeFactId: string;
}

export function formatSanitizedConfirmation(
  factId: string,
  form: VehicleAvailabilityFormInput,
  nowMs: number = Date.now()
): SanitizedConfirmation {
  const wh = PILOT_WAREHOUSES.find((w) => w.id === form.warehouse_id);
  const earliestMs = new Date(form.earliest_available_at).getTime();
  const isAvailableNow = earliestMs <= nowMs;
  const count = Number(form.available_count);

  return {
    warehouseId: form.warehouse_id,
    warehouseName: wh?.name || form.warehouse_id,
    supplierName: form.supplier_name,
    vehicleClass: form.vehicle_class,
    availableCount: count,
    plannedCapacityKg: count * GOVERNED_USABLE_PAYLOAD_KG,
    earliestAvailableAt: form.earliest_available_at,
    validUntil: form.valid_until,
    status: isAvailableNow ? "AVAILABLE_NOW" : "SCHEDULED_AVAILABLE",
    safeFactId: factId ? `${factId.slice(0, 10)}...` : "persisted",
  };
}

export interface FactRowDisplay {
  warehouseId: string;
  warehouseName: string;
  supplierName: string;
  vehicleClass: string;
  countDisplay: string;
  capacityDisplay: string;
  earliestAvailableAt: string;
  validUntil: string;
  status: string;
  source: string;
  isExpired: boolean;
  isSuperseded: boolean;
  supersededAt?: string | null;
  supersedesFactId?: string | null;
  availableCountRaw?: number | null;
}

export function formatFactRow(fact: any, nowMs: number = Date.now()): FactRowDisplay {
  const wh = PILOT_WAREHOUSES.find((w) => w.id === fact.warehouse_id);
  const isSuperseded = Boolean(fact.superseded_at);
  const isExpired = fact.valid_until ? nowMs > new Date(fact.valid_until).getTime() : false;

  let status = "UNKNOWN";
  if (isSuperseded) {
    status = "SUPERSEDED";
  } else if (isExpired) {
    status = "EXPIRED";
  } else if (fact.available_count === 0) {
    status = "UNAVAILABLE";
  } else if (fact.available_count > 0) {
    const earliestMs = fact.available_at ? new Date(fact.available_at).getTime() : 0;
    status = earliestMs <= nowMs ? "AVAILABLE_NOW" : "SCHEDULED_AVAILABLE";
  }

  // UNKNOWN != ZERO semantics
  const countDisplay = fact.available_count != null
    ? `${fact.available_count} xe`
    : "UNKNOWN / NULL";

  const capacityDisplay = fact.available_count != null
    ? `${(fact.available_count * GOVERNED_USABLE_PAYLOAD_KG).toLocaleString("vi-VN")} kg`
    : "UNKNOWN / NULL";

  return {
    warehouseId: fact.warehouse_id,
    warehouseName: wh?.name || fact.warehouse_id,
    supplierName: fact.supplier_name || "—",
    vehicleClass: fact.vehicle_class || GOVERNED_VEHICLE_CLASS,
    countDisplay,
    capacityDisplay,
    earliestAvailableAt: fact.available_at ? new Date(fact.available_at).toLocaleString("vi-VN") : "—",
    validUntil: fact.valid_until ? new Date(fact.valid_until).toLocaleString("vi-VN") : "—",
    status,
    source: fact.source_ref || "AUTHORIZED_OPERATIONAL_FACT",
    isExpired,
    isSuperseded,
    supersededAt: fact.superseded_at || null,
    supersedesFactId: fact.supersedes_fact_id || null,
    availableCountRaw: fact.available_count ?? null,
  };
}

export function findActiveFactForTuple(
  activeFacts: FactRowDisplay[],
  warehouseId: string,
  supplierName: string,
  vehicleClass: string = GOVERNED_VEHICLE_CLASS
): FactRowDisplay | undefined {
  return activeFacts.find(
    (f) =>
      f.warehouseId === warehouseId &&
      f.supplierName.trim().toUpperCase() === supplierName.trim().toUpperCase() &&
      f.vehicleClass.trim().toUpperCase() === vehicleClass.trim().toUpperCase() &&
      !f.isExpired &&
      !f.isSuperseded &&
      f.status !== "SUPERSEDED" &&
      f.status !== "EXPIRED"
  );
}
