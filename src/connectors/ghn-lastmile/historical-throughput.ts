import type { LastmileTrip, LastmileTripItem } from "./trip-workload";

export type HistoricalThroughputSnapshot = {
  hubId: string;
  completedTripSampleCount: number;
  sampledDriverCount: number;
  sufficientHubSample: boolean;
  hubP50DeliveriesPerHour: number | null;
  hubP75DeliveriesPerHour: number | null;
  activeTripCount: number;
  expectedSuccessfulDeliveryCount: number | null;
  observedSuccessfulDeliveryCount: number;
  paceRatio: number | null;
  sourceFetchedAt: string;
};

type CompletedTripSample = { tripCode: string; driverId: string; deliveriesPerHour: number };

const round = (value: number) => Math.round(value * 100) / 100;

const percentileNearestRank = (values: number[], percentile: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)];
};

const isValidIso = (value: string | null | undefined): value is string => Boolean(value && !Number.isNaN(Date.parse(value)));

/**
 * Order codes only exist during in-memory de-duplication. A caller must fetch
 * every page of a trip before using this calculation, otherwise its completion
 * pace is deliberately incomplete and must not be used for a decision.
 */
function countSuccessfulDeliveriesByTrip(items: LastmileTripItem[]) {
  const rows = new Map<string, LastmileTripItem>();
  for (const item of items) {
    if (item.type !== "DELIVER" || !item.orderCode) continue;
    const key = `${item.tripCode}:${item.orderCode}`;
    const previous = rows.get(key);
    const previousTime = previous?.lastUpdatedTime && isValidIso(previous.lastUpdatedTime) ? Date.parse(previous.lastUpdatedTime) : Number.NEGATIVE_INFINITY;
    const nextTime = item.lastUpdatedTime && isValidIso(item.lastUpdatedTime) ? Date.parse(item.lastUpdatedTime) : Number.NEGATIVE_INFINITY;
    if (!previous || nextTime >= previousTime) rows.set(key, item);
  }
  const counts = new Map<string, number>();
  for (const item of rows.values()) {
    if (item.isSucceeded) counts.set(item.tripCode, (counts.get(item.tripCode) || 0) + 1);
  }
  return counts;
}

/**
 * Estimates delivery throughput from completed trips. It is not a vehicle or
 * route-capacity measurement: no distance, payload, route or GPS assumptions
 * are made. Individual driver baselines never appear in the output.
 */
export function buildHistoricalThroughputSnapshot(args: {
  hubId: string;
  completedTrips: LastmileTrip[];
  completedTripItems: LastmileTripItem[];
  activeTrips: LastmileTrip[];
  activeTripItems: LastmileTripItem[];
  at: string;
  sourceFetchedAt: string;
  minimumHubTripSample?: number;
  minimumDriverTripSample?: number;
}): HistoricalThroughputSnapshot {
  const atMs = Date.parse(args.at);
  if (Number.isNaN(atMs)) throw new Error("Invalid snapshot time");
  const completedDeliveries = countSuccessfulDeliveriesByTrip(args.completedTripItems);
  const samples: CompletedTripSample[] = args.completedTrips.flatMap((trip) => {
    if (trip.hubId !== args.hubId || trip.status !== "FINISHED" || !trip.tripCode || !trip.driverId?.trim()) return [];
    if (!isValidIso(trip.startTime) || !isValidIso(trip.endTime)) return [];
    const hours = (Date.parse(trip.endTime) - Date.parse(trip.startTime)) / 3_600_000;
    const successes = completedDeliveries.get(trip.tripCode) || 0;
    if (hours <= 0 || successes <= 0) return [];
    return [{ tripCode: trip.tripCode, driverId: trip.driverId.trim(), deliveriesPerHour: successes / hours }];
  });
  const hubP50 = percentileNearestRank(samples.map((sample) => sample.deliveriesPerHour), 0.5);
  const hubP75 = percentileNearestRank(samples.map((sample) => sample.deliveriesPerHour), 0.75);
  const minimumHubTripSample = args.minimumHubTripSample ?? 10;
  const minimumDriverTripSample = args.minimumDriverTripSample ?? 3;
  const perDriver = new Map<string, number[]>();
  for (const sample of samples) perDriver.set(sample.driverId, [...(perDriver.get(sample.driverId) || []), sample.deliveriesPerHour]);
  const activeDeliveries = countSuccessfulDeliveriesByTrip(args.activeTripItems);
  const activeTrips = args.activeTrips.filter((trip) => trip.hubId === args.hubId && trip.status === "ON_TRIP" && Boolean(trip.tripCode));

  let expected = 0;
  let usableActiveTrips = 0;
  for (const trip of activeTrips) {
    if (!isValidIso(trip.startTime)) continue;
    const elapsedHours = Math.max(0, (atMs - Date.parse(trip.startTime)) / 3_600_000);
    const driverSamples = trip.driverId ? perDriver.get(trip.driverId.trim()) || [] : [];
    const rate = driverSamples.length >= minimumDriverTripSample
      ? percentileNearestRank(driverSamples, 0.5)
      : hubP50;
    if (rate == null) continue;
    const assigned = Number.isFinite(trip.deliverCount) ? Math.max(0, Math.trunc(Number(trip.deliverCount))) : Number.POSITIVE_INFINITY;
    expected += Math.min(assigned, rate * elapsedHours);
    usableActiveTrips += 1;
  }
  const observed = activeTrips.reduce((total, trip) => total + (activeDeliveries.get(trip.tripCode) || 0), 0);
  const sufficientHubSample = samples.length >= minimumHubTripSample;
  const canEvaluatePace = sufficientHubSample && activeTrips.length > 0 && usableActiveTrips === activeTrips.length && expected > 0;
  const sampledDriverCount = new Set(samples.map((sample) => sample.driverId)).size;

  return {
    hubId: args.hubId,
    completedTripSampleCount: samples.length,
    sampledDriverCount,
    sufficientHubSample,
    hubP50DeliveriesPerHour: sufficientHubSample && hubP50 != null ? round(hubP50) : null,
    hubP75DeliveriesPerHour: sufficientHubSample && hubP75 != null ? round(hubP75) : null,
    activeTripCount: activeTrips.length,
    expectedSuccessfulDeliveryCount: canEvaluatePace ? Math.round(expected) : null,
    observedSuccessfulDeliveryCount: observed,
    paceRatio: canEvaluatePace ? round(observed / expected) : null,
    sourceFetchedAt: args.sourceFetchedAt,
  };
}
