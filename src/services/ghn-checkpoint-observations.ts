import { GhnOrderTrackingClient, GhnTrackingError, parseLiveOrderTracking } from "@/connectors/ghn-order-tracking";
import { checkpointKey, type OperationalCohort, type OrderEvidence } from "@/domain/operational-learning/checkpoint-policy";
import warehouseAssignments from "@/data/warehouse-assignments.generated.json";

type Assignment = { warehouseId: string; warehouseName: string; zone: string };
type PrioritizedEvidence = OrderEvidence & { dueAt?: string | null; lastReminderAt?: string; warehouseName?: string };
const assignments = warehouseAssignments.warehouses as Assignment[];
const zoneByWarehouseId = new Map(assignments.map(item => [String(item.warehouseId), item.zone]));
const zoneByWarehouseName = new Map(assignments.map(item => [item.warehouseName, item.zone]));
const PILOT_ZONES = new Set((process.env.TRIAGE_PILOT_ZONES || "Miền Bắc 3").split(",").map(value => value.trim()).filter(Boolean));

export function requiresGhnCheckpointEvidence() {
  // Enable only after the managed session passes its live no-message probe.
  return process.env.GHN_CHECKPOINT_EVIDENCE === "required";
}

export function hasVerifiedReminderEvidence(cohort: OperationalCohort | null | undefined, codes: string[], now: number) {
  if (!cohort?.verification || !codes.length) return false;
  if (checkpointKey(Date.parse(cohort.verification.snapshotAt || cohort.verification.checkedAt)) !== checkpointKey(now)) return false;
  return codes.every(code => {
    const member = cohort.members.find(item => item.orderCode === code);
    return member?.source === "ghn_internal_order_logs" && !cohort.verification?.failures[code]
      && Date.parse(member.observedAt) <= Date.parse(cohort.verification!.checkedAt);
  });
}

/** Pilot-first and due-first: non-pilot work cannot consume the GHN request budget. */
export function prioritizePilotCheckpointCandidates(candidates: PrioritizedEvidence[], now: number) {
  const priority = (order: PrioritizedEvidence) => {
    const dueAt = Date.parse(order.dueAt || "");
    if (Number.isFinite(dueAt) && dueAt <= now) return 0;
    if (order.lastReminderAt) return 1;
    if (!Number.isFinite(dueAt)) return 2;
    return 3;
  };
  return candidates.filter(order => PILOT_ZONES.has(zoneByWarehouseId.get(String(order.warehouseId)) || zoneByWarehouseName.get(order.warehouseName || "") || ""))
    .sort((a, b) => priority(a) - priority(b) || Date.parse(a.readyAt || "9999-12-31") - Date.parse(b.readyAt || "9999-12-31"));
}

const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

function failureReason(error: unknown, code: string) {
  if (!(error instanceof Error)) return code;
  const httpStatus = error.message.match(/HTTP\s+(\d{3})/i)?.[1];
  if (httpStatus) return `${code}_HTTP_${httpStatus}`;
  if (/timed out/i.test(error.message)) return `${code}_TIMEOUT`;
  return code;
}

/** Time-bounded server-side reads. Missing/failed lookups never fall back to Rillnet. */
export async function collectGhnCheckpointObservations(
  candidates: OrderEvidence[],
  client = new GhnOrderTrackingClient(),
  clock: () => number = Date.now,
  sleeper: (milliseconds: number) => Promise<unknown> = pause,
) {
  const observations = new Map<string, OrderEvidence>();
  const failures: Record<string, string> = {};
  const unique = [...new Map(candidates.map(order => [order.orderCode, order])).values()];
  const started = clock();
  let cursor = 0;
  let authFailure: string | null = null;
  let requestCount = 0;
  async function worker() {
    while (cursor < unique.length && clock() - started < 240_000 && !authFailure) {
      const order = unique[cursor++];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          // The internal endpoint returns 429 under burst traffic. Pace every
          // request globally; throughput comes from completing the queue, not concurrency.
          if (requestCount > 0) await sleeper(1_100);
          requestCount += 1;
          const logs = await client.fetchOrderLogs(order.orderCode);
          const checkedAt = new Date(clock()).toISOString();
          const tracking = parseLiveOrderTracking(order.orderCode, logs, {}, checkedAt);
          if (!tracking.status || !tracking.currentWarehouseId || !tracking.lastEventAt
            || !tracking.customerId || tracking.customerId !== order.customerId
            || Date.parse(tracking.lastEventAt) > clock()) {
            failures[order.orderCode] = "INCOMPLETE_OR_MISMATCHED_EVIDENCE";
            break;
          }
          observations.set(order.orderCode, {
            ...order, status: tracking.status, warehouseId: tracking.currentWarehouseId,
            readyAt: tracking.journey.filter(point => point.warehouseId === tracking.currentWarehouseId).at(-1)?.arrivedAt || null,
            observedAt: checkedAt, source: "ghn_internal_order_logs", eventAt: tracking.lastEventAt,
          });
          break;
        } catch (error) {
          const code = error instanceof GhnTrackingError ? error.code : "TRACKING_UNAVAILABLE";
          if (code === "UPSTREAM_ERROR" && attempt < 4 && clock() - started < 225_000) {
            await sleeper(Math.min(12_000, 3_000 * (2 ** attempt)));
            continue;
          }
          failures[order.orderCode] = failureReason(error, code);
          if (code === "UNAUTHORIZED" || code === "NOT_CONFIGURED") authFailure = code;
          break;
        }
      }
    }
  }
  await worker();
  for (const order of unique) {
    if (!observations.has(order.orderCode) && !failures[order.orderCode]) failures[order.orderCode] = authFailure || "BUDGET_DEFERRED";
  }
  return { observations, failures, checkedAt: new Date(clock()).toISOString() };
}
