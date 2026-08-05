import { RillnetClient } from "./client";
import { decompressSnapshot } from "./snapshot";
import { parseSnapshot } from "./parser";
import { mapRawOrderToNormalized } from "./mapper";
import type {
  NormalizedRillnetOrder,
  RillnetFetchResult,
  RillnetDebugSummary,
} from "./types";

export * from "./types";
export * from "./client";
export * from "./snapshot";
export * from "./parser";
export * from "./mapper";

export class RillnetConnector {
  private client: RillnetClient;

  constructor(client?: RillnetClient) {
    this.client = client || new RillnetClient();
  }

  /**
   * Fetches, decompresses, parses, and normalizes Rillnet snapshot orders
   */
  async fetchSnapshot(): Promise<RillnetFetchResult> {
    const { downloadUrl, updatedAt } = await this.client.requestSnapshotUrl();
    const buffer = await this.client.downloadSnapshotBuffer(downloadUrl);
    const jsonText = await decompressSnapshot(buffer);
    const rawOrders = parseSnapshot(jsonText);

    const orders: NormalizedRillnetOrder[] = rawOrders.map((raw) =>
      mapRawOrderToNormalized(raw, updatedAt)
    );

    return {
      fetchedAt: updatedAt,
      totalOrders: orders.length,
      orders,
    };
  }

  /**
   * Fetches snapshot and calculates debug summary statistics
   */
  async fetchDebugSummary(): Promise<RillnetDebugSummary> {
    const { fetchedAt, totalOrders, orders } = await this.fetchSnapshot();

    const statusCounts: Record<string, number> = {};
    for (const order of orders) {
      const statusKey = order.status || "unknown";
      statusCounts[statusKey] = (statusCounts[statusKey] || 0) + 1;
    }

    const first5Orders = orders.slice(0, 5);

    return {
      fetchedAt,
      totalOrders,
      statusCounts,
      first5Orders,
    };
  }
}
