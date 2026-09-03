/**
 * Privacy-minimised, read-only projection of GHN Lastmile trip activity.
 * Raw trip items can contain contacts, addresses, COD values and coordinates;
 * callers must project them to these fields before they reach this module.
 */
export type LastmileTrip = {
  tripCode: string;
  status: string;
  hubId: string;
  driverId?: string | null;
  deliverCount?: number | null;
  pickCount?: number | null;
  returnCount?: number | null;
  startTime?: string | null;
  endTime?: string | null;
  lastUpdatedTime?: string | null;
};

export type LastmileTripItem = {
  tripCode: string;
  orderCode: string;
  type: "PICK" | "DELIVER" | "RETURN";
  isSucceeded: boolean;
  isReturn?: boolean;
  isCancel?: boolean;
  lastUpdatedTime?: string | null;
};

export type ActiveTripWorkloadSnapshot = {
  hubId: string;
  activeTripCount: number;
  activeDriverCount: number;
  assignedDeliveryCount: number;
  successfulDeliveryCount: number;
  pendingDeliveryCount: number;
  returnCount: number;
  cancelledCount: number;
  latestSourceUpdatedAt: string | null;
  sourceFetchedAt: string;
};

const positive = (value: number | null | undefined) => Number.isFinite(value) ? Math.max(0, Math.trunc(Number(value))) : 0;
const maxIso = (values: Array<string | null | undefined>) => values.filter((value): value is string => Boolean(value && !Number.isNaN(Date.parse(value)))).sort().at(-1) || null;

/**
 * Aggregates only current trips from exactly one hub. Order codes are used
 * transiently to deduplicate source rows and are never returned or persisted.
 */
export function buildActiveTripWorkloadSnapshot(
  hubId: string,
  trips: LastmileTrip[],
  items: LastmileTripItem[],
  sourceFetchedAt: string
): ActiveTripWorkloadSnapshot {
  const activeTrips = trips.filter((trip) => trip.hubId === hubId && trip.status === "ON_TRIP" && Boolean(trip.tripCode));
  const activeCodes = new Set(activeTrips.map((trip) => trip.tripCode));
  const uniqueItems = new Map<string, LastmileTripItem>();
  for (const item of items) {
    if (!activeCodes.has(item.tripCode) || !item.orderCode) continue;
    const key = `${item.tripCode}:${item.type}:${item.orderCode}`;
    const existing = uniqueItems.get(key);
    const existingTime = existing?.lastUpdatedTime ? Date.parse(existing.lastUpdatedTime) : Number.NEGATIVE_INFINITY;
    const nextTime = item.lastUpdatedTime ? Date.parse(item.lastUpdatedTime) : Number.NEGATIVE_INFINITY;
    // Source retries can repeat one item. Keep the freshest valid observation;
    // an incomplete duplicate must never make the snapshot look older.
    if (!existing || nextTime >= existingTime) uniqueItems.set(key, item);
  }
  const rows = [...uniqueItems.values()];
  const deliveryRows = rows.filter((item) => item.type === "DELIVER");
  const successfulDeliveryCount = deliveryRows.filter((item) => item.isSucceeded).length;
  const assignedFromTrips = activeTrips.reduce((sum, trip) => sum + positive(trip.deliverCount), 0);
  const assignedDeliveryCount = assignedFromTrips || deliveryRows.length;
  const returnCount = rows.filter((item) => item.type === "RETURN" || item.isReturn).length;
  const cancelledCount = rows.filter((item) => item.isCancel).length;

  return {
    hubId,
    activeTripCount: activeTrips.length,
    activeDriverCount: new Set(activeTrips.map((trip) => trip.driverId?.trim()).filter(Boolean)).size,
    assignedDeliveryCount,
    successfulDeliveryCount: Math.min(successfulDeliveryCount, assignedDeliveryCount),
    pendingDeliveryCount: Math.max(0, assignedDeliveryCount - successfulDeliveryCount),
    returnCount,
    cancelledCount,
    latestSourceUpdatedAt: maxIso([...activeTrips.map((trip) => trip.lastUpdatedTime), ...rows.map((item) => item.lastUpdatedTime)]),
    sourceFetchedAt,
  };
}
