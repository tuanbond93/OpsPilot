import type { NormalizedRillnetOrder } from "@/connectors/rillnet";
import { canonicalWarehouseType } from "@/connectors/ghn-order-tracking/warehouse-directory";

export const CHECKPOINT_HOURS = [8, 10, 12, 14, 16, 18] as const;
const FINAL_CHECKPOINT_HOUR = CHECKPOINT_HOURS[CHECKPOINT_HOURS.length - 1];
export const OPERATIONAL_CHECKPOINT_POLICY_VERSION = "2026-09-06.1" as const;
const DAY = 86_400_000;
/** Rillnet snapshot updatedAt may lag a checkpoint, but cannot be arbitrarily old. */
export const RILLNET_SNAPSHOT_FRESHNESS_TOLERANCE_MS = 60 * 60 * 1000;
export const localDay = (time: number) => new Date(time + 7 * 3_600_000).toISOString().slice(0, 10);
export const localHour = (time: number) => new Date(time + 7 * 3_600_000).getUTCHours();
export const atHour = (day: string, hour: number) => Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00+07:00`);
export function nextCot(readyAt: string, hour: number): number {
  const ready = Date.parse(readyAt);
  if (!Number.isFinite(ready)) return NaN;
  const cot = atHour(localDay(ready), hour);
  // A scan exactly at departure is not evidence of loading before departure.
  return ready < cot ? cot : cot + DAY;
}
export function checkpointKey(now: number): string | null {
  const hour = localHour(now);
  return CHECKPOINT_HOURS.includes(hour as typeof CHECKPOINT_HOURS[number]) ? `${localDay(now)}:${hour}` : null;
}
export function isFreshRillnetSnapshot(snapshotAt: string | null | undefined, now: number): boolean {
  const timestamp = Date.parse(snapshotAt || "");
  return Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= RILLNET_SNAPSHOT_FRESHNESS_TOLERANCE_MS;
}
export function nextCheckpoint(now: number): string {
  const day = localDay(now);
  return new Date(CHECKPOINT_HOURS.map(hour => atHour(day, hour)).find(time => time > now) ?? atHour(localDay(now + DAY), 8)).toISOString();
}

export type OrderStage = "DELIVERY" | "TRANSIT" | "OUTBOUND" | "UNKNOWN";
export type OrderEvidence = {
  orderCode: string; customerId: string; warehouseId: string; stage: OrderStage;
  status: string; observedAt: string; readyAt: string | null;
  source?: "rillnet" | "ghn_internal_order_logs";
  eventAt?: string;
  observedWarehouseId?: string;
};
export function isOrderEvidence(value: unknown): value is OrderEvidence {
  if (!value || typeof value !== "object") return false;
  const order = value as Record<string, unknown>;
  return ["orderCode", "customerId", "warehouseId", "status"].every(key => typeof order[key] === "string" && Boolean(order[key]))
    && ["DELIVERY", "TRANSIT", "OUTBOUND", "UNKNOWN"].includes(String(order.stage))
    && typeof order.observedAt === "string" && Number.isFinite(Date.parse(order.observedAt))
    && (order.readyAt === null || typeof order.readyAt === "string" && Number.isFinite(Date.parse(order.readyAt)));
}
export type CohortMember = OrderEvidence & {
  firstSeenAt: string; dueAt: string | null; baselineStatus: string;
  lastReminderAt?: string; lastReminderStatus?: string;
  completedAt?: string;
};
export type OperationalCohort = {
  version: 1; day: string; capturedAt: string; baselineCodes: string[];
  members: CohortMember[]; lastCheckpoint?: string;
  verification?: { source: "ghn_internal_order_logs"; checkedAt: string; snapshotAt?: string; failures: Record<string, string> };
};
export type CohortAssessment = {
  cohort: OperationalCohort; due: number; completed: number; progressed: number;
  pending: number; unknown: number; waiting: number; newOrders: number;
  reminderCodes: string[]; progressPercent: number;
  baselineDue: number; baselineProgressed: number; baselinePending: number; newDue: number;
  assessment: "strong_progress" | "limited_progress" | "no_progress" | "insufficient_data";
};
const delivering = (status: string) => ["delivering", "money_collect_delivering"].includes(status);
const delivered = (status: string) => ["delivered", "success"].includes(status);
const failed = (status: string) => ["delivery_fail", "return", "returning", "returned"].includes(status);

export function evidenceFromOrder(order: NormalizedRillnetOrder): OrderEvidence {
  const transit = /chuyển tiếp|trung chuyển|\bhub\b/i.test(order.warehouseName);
  const localWarehouse = /giao hàng nặng|kho ghn|bưu cục|buu cuc/i.test(order.warehouseName) || canonicalWarehouseType(order.warehouseId) === "Bưu cục";
  const stage: OrderStage = order.orderCode.toUpperCase().endsWith("_CPTT") ? "UNKNOWN" : transit ? "TRANSIT" : order.deliverWarehouseId === order.warehouseId ? "DELIVERY"
    : localWarehouse && order.deliverWarehouseId ? "OUTBOUND" : "UNKNOWN";
  const arrivals = (order.warehouseLog || []).flatMap(entry => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (String(row.current_warehouse_id ?? row.warehouse_id ?? "") !== order.warehouseId) return [];
    const raw = row.updated_date ?? row.time;
    const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>).$date : raw;
    return typeof value === "string" && Number.isFinite(Date.parse(value)) ? [value] : [];
  }).sort((a, b) => Date.parse(b) - Date.parse(a));
  const arrival = arrivals[0] || null;
  const readyAt = stage === "OUTBOUND" && order.endPickAt
    ? new Date(Math.max(Date.parse(order.endPickAt), arrival ? Date.parse(arrival) : 0)).toISOString() : arrival;
  return { orderCode: order.orderCode, customerId: order.customerId, warehouseId: order.warehouseId,
    stage, status: order.status.toLowerCase().trim(), observedAt: order.fetchedAt,
    readyAt: readyAt || (order.status ? order.fetchedAt : null), source: "rillnet" };
}

function dueAt(order: OrderEvidence, now: number): string | null {
  if (order.stage === "DELIVERY" && localHour(now) === 8) return new Date(atHour(localDay(now), 10)).toISOString();
  if (!order.readyAt || !Number.isFinite(Date.parse(order.readyAt))) return null;
  if (order.stage === "TRANSIT" || order.stage === "OUTBOUND") return new Date(nextCot(order.readyAt, order.stage === "TRANSIT" ? 7 : 18)).toISOString();
  if (order.stage !== "DELIVERY") return null;
  // Only stock present by the morning baseline has an approved same-day delivery deadline.
  const ready = Date.parse(order.readyAt);
  const morning = atHour(localDay(ready), 8);
  const day = localDay(ready <= morning ? ready : ready + DAY);
  return new Date(atHour(day, 10)).toISOString();
}

/** Immutable 08h cohort + separately counted new work; unfinished members survive midnight. */
export function assessOperationalCohort(previous: OperationalCohort | null | undefined, incoming: OrderEvidence[], observations: Map<string, OrderEvidence>, now: number): CohortAssessment {
  const day = localDay(now);
  const cohort: OperationalCohort = previous ? structuredClone(previous) : { version: 1, day, capturedAt: new Date(now).toISOString(), baselineCodes: [], members: [] };
  if (cohort.day !== day && localHour(now) >= 8) {
    cohort.members = cohort.members.filter(member => !member.completedAt);
    cohort.day = day; cohort.capturedAt = new Date(now).toISOString(); cohort.lastCheckpoint = undefined;
    cohort.baselineCodes = cohort.members.map(member => member.orderCode);
  }
  const members = new Map(cohort.members.map(member => [member.orderCode, member]));
  for (const order of incoming) {
    if (members.has(order.orderCode)) continue;
    members.set(order.orderCode, { ...order, firstSeenAt: new Date(now).toISOString(), baselineStatus: order.status, dueAt: dueAt(order, now) });
    if (localHour(now) === 8) cohort.baselineCodes.push(order.orderCode);
  }
  cohort.members = [...members.values()];
  const result: CohortAssessment = { cohort, due: 0, completed: 0, progressed: 0, pending: 0, unknown: 0, waiting: 0,
    newOrders: cohort.members.filter(member => !cohort.baselineCodes.includes(member.orderCode)).length,
    reminderCodes: [], progressPercent: 0, assessment: "insufficient_data", baselineDue: 0, baselineProgressed: 0, baselinePending: 0, newDue: 0 };
  const checkpoint = checkpointKey(now);
  for (const member of cohort.members) {
    const observation = observations.get(member.orderCode);
    // observedAt is the current Rillnet snapshot's updatedAt, not an order event time.
    const fresh = observation && isFreshRillnetSnapshot(observation.observedAt, now);
    if (fresh && observation.customerId === member.customerId) {
      member.source = observation.source; member.eventAt = observation.eventAt;
      member.status = observation.status; member.observedAt = observation.observedAt;
      member.observedWarehouseId = observation.warehouseId;
      if (observation.warehouseId === member.warehouseId && member.stage !== "DELIVERY") {
        member.readyAt = observation.readyAt;
        member.dueAt = dueAt(observation, now);
      }
    }
    if (!member.dueAt && fresh && observation.warehouseId === member.warehouseId && observation.customerId === member.customerId) {
      member.readyAt = observation.readyAt;
      member.stage = observation.stage;
      member.dueAt = dueAt(observation, now);
    }
    if (!member.dueAt) { result.unknown++; continue; }
    if (Date.parse(member.dueAt) > now) { result.waiting++; continue; }
    result.due++;
    if (member.completedAt) { result.completed++; result.progressed++; continue; }
    if (!fresh || observation.customerId !== member.customerId) { result.unknown++; continue; }
    const status = observation.status;
    const sameWarehouse = observation.warehouseId === member.warehouseId;
    const done = member.stage === "DELIVERY" ? delivered(status)
      : !failed(status) && ((["storing", "picked"].includes(member.baselineStatus) && ["transporting", "delivering", "money_collect_delivering"].includes(status)) || delivered(status));
    const progress = done || (member.stage === "DELIVERY" && delivering(status));
    if (done) { result.completed++; member.completedAt = observation.observedAt; }
    if (progress) result.progressed++;
    if (!done) result.pending++;
    const actionable = !done && sameWarehouse && (["storing", "picked"].includes(status)
      || member.stage === "DELIVERY" && (failed(status) && localHour(now) >= 14 || delivering(status) && localHour(now) === FINAL_CHECKPOINT_HOUR));
    const changed = member.lastReminderStatus && member.lastReminderStatus !== status;
    // Unchanged work is reminded only at the final checkpoint or on a later day.
    const repeatDue = !member.lastReminderAt || localDay(Date.parse(member.lastReminderAt)) !== day || localHour(now) === FINAL_CHECKPOINT_HOUR || changed;
    // The 08:00 checkpoint may identify a genuinely due first push.  The
    // follow-up engine limits that baseline eligibility to cases entering the
    // first-push workflow; later ladder stages remain suppressed at 08:00.
    if (checkpoint && cohort.lastCheckpoint !== checkpoint && actionable && repeatDue) result.reminderCodes.push(member.orderCode);
    member.status = status; member.observedAt = observation.observedAt;
    member.source = observation.source; member.eventAt = observation.eventAt;
  }
  const baselineCodes = new Set(cohort.baselineCodes);
  for (const member of cohort.members) {
    if (!member.dueAt || Date.parse(member.dueAt) > now) continue;
    if (!baselineCodes.has(member.orderCode)) { result.newDue++; continue; }
    result.baselineDue++;
    const fresh = isFreshRillnetSnapshot(member.observedAt, now);
    if (member.completedAt || fresh && member.stage === "DELIVERY" && delivering(member.status)) result.baselineProgressed++;
    if (!member.completedAt) result.baselinePending++;
  }
  const denominator = result.baselineDue || result.due;
  const numerator = result.baselineDue ? result.baselineProgressed : result.progressed;
  result.progressPercent = denominator ? Math.round(numerator / denominator * 1000) / 10 : 0;
  result.assessment = localHour(now) === 8 || !result.due || result.unknown ? "insufficient_data"
    : result.progressPercent >= 20 ? "strong_progress" : result.progressPercent > 0 ? "limited_progress" : "no_progress";
  return result;
}
