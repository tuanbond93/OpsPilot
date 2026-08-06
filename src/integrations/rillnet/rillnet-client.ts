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
   * Helper to perform fetch and response body consumption with timeout covering BOTH header fetch
   * AND response body reading, with retry logic and stream resource cleanup.
   */
  private async executeWithTimeout<T>(
    url: string,
    options: RequestInit = {},
    reader: (response: Response) => Promise<T>
  ): Promise<T> {
    let lastError: any = null;
    let delay = 1000;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      let headerDurationMs = 0;
      let bodyDurationMs = 0;
      let headersReceived = false;
      const tStart = performance.now();

      const id = setTimeout(() => {
        controller.abort();
      }, this.timeoutMs);

      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers: {
            ...options.headers,
            "Accept-Encoding": "gzip",
          },
        });

        const tHeader = performance.now();
        headerDurationMs = Math.round(tHeader - tStart);
        headersReceived = true;

        if (!response.ok) {
          if (response.body && typeof response.body.cancel === "function") {
            response.body.cancel().catch(() => {});
          }
          throw new Error(`HTTP Error Status: ${response.status}`);
        }

        // Read response body while timeout timer remains ACTIVE
        let result: T;
        try {
          result = await reader(response);
        } catch (readErr: any) {
          if (response.body && typeof response.body.cancel === "function") {
            response.body.cancel().catch(() => {});
          }
          throw readErr;
        }

        bodyDurationMs = Math.round(performance.now() - tHeader);
        const byteCount =
          result instanceof ArrayBuffer
            ? result.byteLength
            : typeof result === "string"
            ? result.length
            : JSON.stringify(result).length;

        console.log(
          `[RillnetClient] Fetch Success | Attempt: ${attempt}/${this.maxRetries} | HeaderDuration: ${headerDurationMs}ms | BodyDuration: ${bodyDurationMs}ms | Bytes: ${byteCount}`
        );

        this.lastSuccessAt = new Date().toISOString();
        return result;
      } catch (err: any) {
        lastError = err;
        this.lastFailureAt = new Date().toISOString();

        const isAbort = err?.name === "AbortError" || controller.signal.aborted;
        if (isAbort) {
          const stage = headersReceived ? "response-body timeout" : "connection/header timeout";
          this.lastErrorReason = `Rillnet ${stage} after ${this.timeoutMs}ms`;
          lastError = new Error(this.lastErrorReason, { cause: err });
        } else {
          this.lastErrorReason = err?.message || String(err);
        }

        console.warn(
          `[RillnetClient] Fetch Failed | Attempt: ${attempt}/${this.maxRetries} | Reason: ${this.lastErrorReason}`
        );

        if (attempt === this.maxRetries) break;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      } finally {
        clearTimeout(id);
      }
    }

    throw lastError || new Error(`Rillnet call failed after ${this.maxRetries} attempts`);
  }

  /**
   * Request snapshot download URL
   */
  async requestSnapshotUrl(): Promise<RillnetSnapshotUrlDTO> {
    try {
      const data = await this.executeWithTimeout(
        this.endpointApi,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op: "opssnap" }),
        },
        async (res) => {
          try {
            return await res.json();
          } catch (jsonErr: any) {
            throw new Error(`Malformed JSON response body: ${jsonErr.message}`, { cause: jsonErr });
          }
        }
      );

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
      return await this.executeWithTimeout(url, {}, async (res) => {
        return await res.arrayBuffer();
      });
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
      return await this.executeWithTimeout(this.endpointMeta, {}, async (res) => {
        try {
          return await res.json();
        } catch (jsonErr: any) {
          throw new Error(`Malformed metadata JSON: ${jsonErr.message}`, { cause: jsonErr });
        }
      });
    } catch {
      return {};
    }
  }

  /**
   * Health Check implementation
   */
  async health(): Promise<ComponentHealth> {
    try {
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
