import type { ComponentHealth, HealthCheckable } from "../health";
import { SecretProvider } from "../secrets";

export interface RillnetSnapshotUrlDTO {
  downloadUrl: string;
  updatedAt: string;
}

export interface RillnetMetaDTO {
  [warehouseId: string]: {
    name: string;
    region?: string;
  };
}

export class RillnetClient implements HealthCheckable {
  readonly name = "Rillnet";
  private lastSuccessAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastErrorReason: string | null = null;

  private endpointApi: string;
  private endpointMeta: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor() {
    this.endpointApi = SecretProvider.getOptional("RILLNET_API_ENDPOINT", "https://rillnet-app.vercel.app/api/gtalk-send");
    this.endpointMeta = SecretProvider.getOptional("RILLNET_META_ENDPOINT", "https://rillnet-app.vercel.app/wh_meta.json");
    this.timeoutMs = SecretProvider.getNumber("RILLNET_TIMEOUT_MS", 10000); // default 10s
    this.maxRetries = SecretProvider.getNumber("RILLNET_MAX_RETRIES", 3);
  }

  /**
   * Helper to perform fetch requests with timeout and retries
   */
  private async fetchWithRetry(url: string, options: RequestInit = {}): Promise<Response> {
    let lastError: any = null;
    let delay = 1000;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers: {
            ...options.headers,
            "Accept-Encoding": "gzip",
          },
        });

        clearTimeout(id);

        if (response.ok) {
          this.lastSuccessAt = new Date().toISOString();
          return response;
        }

        throw new Error(`HTTP Error Status: ${response.status}`);
      } catch (err: any) {
        clearTimeout(id);
        lastError = err;
        this.lastFailureAt = new Date().toISOString();
        this.lastErrorReason = err?.message || String(err);

        if (attempt === this.maxRetries) break;
        // Exponential backoff
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }

    throw new Error(`Rillnet call failed after ${this.maxRetries} attempts. Last error: ${lastError?.message || String(lastError)}`);
  }

  /**
   * Request snapshot download URL
   */
  async requestSnapshotUrl(): Promise<RillnetSnapshotUrlDTO> {
    try {
      const response = await this.fetchWithRetry(this.endpointApi, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "opssnap" }),
      });

      const data = await response.json();
      const downloadUrl = data.liveUrl || data.url;
      if (!downloadUrl || typeof downloadUrl !== "string") {
        throw new Error("Response did not contain a valid snapshot download URL");
      }

      return {
        downloadUrl,
        updatedAt: data.liveUpdated || data.updated || new Date().toISOString(),
      };
    } catch (err: any) {
      this.lastFailureAt = new Date().toISOString();
      this.lastErrorReason = err.message;
      throw err;
    }
  }

  /**
   * Downloads snapshot data
   */
  async downloadSnapshot(url: string): Promise<ArrayBuffer> {
    try {
      const response = await this.fetchWithRetry(url);
      return await response.arrayBuffer();
    } catch (err: any) {
      this.lastFailureAt = new Date().toISOString();
      this.lastErrorReason = err.message;
      throw err;
    }
  }

  /**
   * Fetch metadata
   */
  async fetchWarehouseMeta(): Promise<RillnetMetaDTO> {
    try {
      const response = await this.fetchWithRetry(this.endpointMeta);
      return await response.json();
    } catch (err: any) {
      // Return empty meta to not block sync
      return {};
    }
  }

  /**
   * Health Check implementation
   */
  async health(): Promise<ComponentHealth> {
    try {
      // Basic lightweight healthcheck by fetching meta with low timeout
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(this.endpointMeta, { signal: controller.signal });
      clearTimeout(id);

      if (res.ok) {
        this.lastSuccessAt = new Date().toISOString();
        return {
          status: "GREEN",
          healthReason: "Successfully connected to Rillnet metadata endpoint",
          lastSuccessAt: this.lastSuccessAt,
          lastFailureAt: this.lastFailureAt,
          freshnessSeconds: 0,
        };
      }

      throw new Error(`Rillnet healthcheck returned HTTP ${res.status}`);
    } catch (err: any) {
      this.lastFailureAt = new Date().toISOString();
      this.lastErrorReason = err?.message || String(err);
      return {
        status: "RED",
        healthReason: `Rillnet connection failed: ${this.lastErrorReason}`,
        lastSuccessAt: this.lastSuccessAt,
        lastFailureAt: this.lastFailureAt,
        freshnessSeconds: this.lastSuccessAt
          ? Math.round((Date.now() - new Date(this.lastSuccessAt).getTime()) / 1000)
          : null,
      };
    }
  }
}
