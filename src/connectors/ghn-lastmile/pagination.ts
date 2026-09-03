import type { LastmileTrip, LastmileTripItem } from "./trip-workload";

export type TripListPage = { total: number; data: LastmileTrip[] };
export type TripItemsPage = { total: number; data: LastmileTripItem[] };

/** Generic pagination boundary; authentication stays outside this module. */
export async function collectFinishedTrips(args: {
  hubId: string;
  request: (payload: Record<string, unknown>) => Promise<TripListPage>;
  pageSize?: number;
  maxPages?: number;
}): Promise<LastmileTrip[]> {
  const pageSize = Math.max(1, Math.min(100, Math.trunc(args.pageSize ?? 20)));
  const maxPages = Math.max(1, Math.trunc(args.maxPages ?? 100));
  const result: LastmileTrip[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await args.request({ hub_id: args.hubId, status: "FINISHED", is_ready: 0, offset: (page - 1) * pageSize, limit: pageSize, size: pageSize, reverse: 1, page });
    result.push(...response.data.filter((trip) => trip.hubId === args.hubId && trip.status === "FINISHED"));
    if (result.length >= response.total || response.data.length < pageSize) break;
  }
  return result;
}

/** Fetches every item page for one trip; callers must aggregate and discard raw rows. */
export async function collectTripItems(args: {
  tripCode: string;
  request: (payload: Record<string, unknown>) => Promise<TripItemsPage>;
  pageSize?: number;
  maxPages?: number;
}): Promise<LastmileTripItem[]> {
  const pageSize = Math.max(1, Math.min(100, Math.trunc(args.pageSize ?? 50)));
  const maxPages = Math.max(1, Math.trunc(args.maxPages ?? 100));
  const result: LastmileTripItem[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const offset = (page - 1) * pageSize;
    const response = await args.request({ typeList: ["PICK", "DELIVER", "RETURN"], offset, limit: pageSize, TripCode: args.tripCode });
    result.push(...response.data.filter((item) => item.tripCode === args.tripCode));
    if (result.length >= response.total || response.data.length < pageSize) break;
  }
  return result;
}
