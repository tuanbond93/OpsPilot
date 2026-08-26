import type { GhnOrderLogEntry, GhnOrderLogsResponse } from "./types";

const DEFAULT_ENDPOINT = "https://fe-online-gateway.ghn.vn/order-tracking/public-api/internal/order-logs";
const DEFAULT_META_ENDPOINT = "https://rillnet-app.vercel.app/wh_meta.json";

export class GhnTrackingError extends Error {
  constructor(message: string, public readonly code: "NOT_CONFIGURED" | "UNAUTHORIZED" | "UPSTREAM_ERROR" | "INVALID_RESPONSE") {
    super(message);
    this.name = "GhnTrackingError";
  }
}

export class GhnOrderTrackingClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async fetchOrderLogs(orderCode: string): Promise<GhnOrderLogEntry[]> {
    const token = (process.env.GHN_INTERNAL_TRACKING_TOKEN || "").trim();
    if (!token) throw new GhnTrackingError("GHN tracking is not configured.", "NOT_CONFIGURED");
    const url = new URL(process.env.GHN_ORDER_LOGS_ENDPOINT || DEFAULT_ENDPOINT);
    url.searchParams.set("order_code", orderCode);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await this.fetcher(url, {
        cache: "no-store",
        headers: {
          accept: "application/json",
          origin: "https://tracuunoibo.ghn.vn",
          referer: "https://tracuunoibo.ghn.vn/",
          token,
        },
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) throw new GhnTrackingError("GHN tracking credentials were rejected.", "UNAUTHORIZED");
      if (!response.ok) throw new GhnTrackingError(`GHN tracking returned HTTP ${response.status}.`, "UPSTREAM_ERROR");
      const payload = await response.json() as GhnOrderLogsResponse;
      if (payload.code !== 200 || !Array.isArray(payload.data?.data)) throw new GhnTrackingError("GHN tracking returned an invalid response.", "INVALID_RESPONSE");
      return payload.data.data;
    } catch (error) {
      if (error instanceof GhnTrackingError) throw error;
      throw new GhnTrackingError(error instanceof Error && error.name === "AbortError" ? "GHN tracking timed out." : "GHN tracking is unavailable.", "UPSTREAM_ERROR");
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchWarehouseNames(ids: string[]): Promise<Record<string, string>> {
    if (!ids.length) return {};
    try {
      const response = await this.fetcher(process.env.RILLNET_META_ENDPOINT || DEFAULT_META_ENDPOINT, { next: { revalidate: 3600 } });
      if (!response.ok) return {};
      const metadata = await response.json() as Record<string, { n?: string; name?: string }>;
      return Object.fromEntries(ids.flatMap((id) => {
        const name = metadata[id]?.n || metadata[id]?.name;
        return name ? [[id, name]] : [];
      }));
    } catch {
      return {};
    }
  }
}

