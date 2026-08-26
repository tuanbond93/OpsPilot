import type { ComponentHealth, HealthCheckable } from "../health";
import { SecretProvider } from "../secrets";
import { RillnetErrorCode, RillnetDownloadError } from "./errors";
import { logger } from "@/observability/logger";

export { RillnetErrorCode, RillnetDownloadError };

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

export interface RillnetAcquireResult {
  buffer: ArrayBuffer;
  downloadUrl: string;
  updatedAt: string;
  attempts: number;
  urlRefreshes: number;
  totalDurationMs: number;
}

export class RillnetClient implements HealthCheckable {
  readonly name = "Rillnet";
  private lastSuccessAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastErrorReason: string | null = null;

  private endpointApi: string;
  private endpointMeta: string;
  private timeoutMs: number;
  private totalDeadlineMs: number;
  private maxRetries: number;
  private maxUrlRefreshes: number;

  constructor() {
    this.endpointApi = SecretProvider.getOptional("RILLNET_API_ENDPOINT", "https://rillnet-app.vercel.app/api/gtalk-send");
    this.endpointMeta = SecretProvider.getOptional("RILLNET_META_ENDPOINT", "https://rillnet-app.vercel.app/wh_meta.json");
    this.timeoutMs = SecretProvider.getNumber("RILLNET_TIMEOUT_MS", 10000); // 10s per-attempt timeout
    this.totalDeadlineMs = SecretProvider.getNumber("RILLNET_TOTAL_DEADLINE_MS", 30000); // 30s overall deadline
    this.maxRetries = SecretProvider.getNumber("RILLNET_MAX_RETRIES", 3);
    this.maxUrlRefreshes = SecretProvider.getNumber("RILLNET_MAX_URL_REFRESHES", 2);
  }

  /**
   * Classify an HTTP response or Error into a typed RillnetErrorCode
   */
  private classifyError(errOrStatus: any, headersReceived: boolean): { code: RillnetErrorCode; status?: number; isRetryable: boolean } {
    if (typeof errOrStatus === "number") {
      const status = errOrStatus;
      if (status === 403 || status === 404 || status === 401) {
        return { code: RillnetErrorCode.SIGNED_URL_EXPIRED_OR_INVALID, status, isRetryable: true };
      }
      if (status === 408 || status === 429 || status >= 500) {
        return { code: RillnetErrorCode.HTTP_RETRYABLE, status, isRetryable: true };
      }
      return { code: RillnetErrorCode.HTTP_NON_RETRYABLE, status, isRetryable: false };
    }

    const err = errOrStatus;
    if (err instanceof RillnetDownloadError) {
      const retryableCodes = [
        RillnetErrorCode.CONNECTION_TIMEOUT,
        RillnetErrorCode.RESPONSE_BODY_TIMEOUT,
        RillnetErrorCode.HTTP_RETRYABLE,
        RillnetErrorCode.SIGNED_URL_EXPIRED_OR_INVALID,
      ];
      return { code: err.code, status: err.status, isRetryable: retryableCodes.includes(err.code) };
    }

    const isAbort = err?.name === "AbortError";
    if (isAbort) {
      const code = headersReceived ? RillnetErrorCode.RESPONSE_BODY_TIMEOUT : RillnetErrorCode.CONNECTION_TIMEOUT;
      return { code, isRetryable: true };
    }

    return { code: RillnetErrorCode.HTTP_RETRYABLE, isRetryable: true };
  }

  /**
   * Helper to perform a single fetch attempt under an explicit timeout signal
   */
  private async executeSingleAttempt<T>(
    url: string,
    options: RequestInit = {},
    reader: (response: Response) => Promise<T>,
    attemptTimeoutMs: number
  ): Promise<T> {
    const controller = new AbortController();
    let headersReceived = false;

    const id = setTimeout(() => {
      controller.abort();
    }, attemptTimeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...options.headers,
          "Accept-Encoding": "gzip",
        },
      });

      headersReceived = true;

      if (!response.ok) {
        if (response.body && typeof response.body.cancel === "function") {
          response.body.cancel().catch(() => {});
        }
        const { code } = this.classifyError(response.status, headersReceived);
        throw new RillnetDownloadError(code, `HTTP Error Status: ${response.status}`, response.status);
      }

      try {
        return await reader(response);
      } catch (readErr: any) {
        if (response.body && typeof response.body.cancel === "function") {
          response.body.cancel().catch(() => {});
        }
        if (readErr instanceof RillnetDownloadError) throw readErr;
        const isAbort = readErr?.name === "AbortError" || controller.signal.aborted;
        const code = isAbort ? RillnetErrorCode.RESPONSE_BODY_TIMEOUT : RillnetErrorCode.HTTP_RETRYABLE;
        const msg = isAbort ? `Rillnet response-body timeout after ${attemptTimeoutMs}ms` : (readErr?.message || String(readErr));
        throw new RillnetDownloadError(code, msg, undefined, readErr);
      }
    } catch (err: any) {
      if (err instanceof RillnetDownloadError) throw err;

      const isAbort = err?.name === "AbortError" || controller.signal.aborted;
      const stage = headersReceived ? "response-body timeout" : "connection/header timeout";
      const code = isAbort
        ? (headersReceived ? RillnetErrorCode.RESPONSE_BODY_TIMEOUT : RillnetErrorCode.CONNECTION_TIMEOUT)
        : this.classifyError(err, headersReceived).code;
      const msg = isAbort ? `Rillnet ${stage} after ${attemptTimeoutMs}ms` : (err?.message || String(err));

      throw new RillnetDownloadError(code, msg, undefined, err);
    } finally {
      clearTimeout(id);
    }
  }

  /**
   * General retry wrapper for non-snapshot calls (requestSnapshotUrl, fetchWarehouseMeta)
   */
  private async executeWithRetry<T>(
    url: string,
    options: RequestInit = {},
    reader: (response: Response) => Promise<T>
  ): Promise<T> {
    let lastError: any = null;
    let baseDelay = Math.min(this.timeoutMs / 2, 1000);

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.executeSingleAttempt(url, options, reader, this.timeoutMs);
      } catch (err: any) {
        lastError = err;
        this.lastFailureAt = new Date().toISOString();
        this.lastErrorReason = err?.message || String(err);

        const { isRetryable } = this.classifyError(err, false);
        if (!isRetryable || attempt === this.maxRetries) break;

        const jitter = Math.random() * 50;
        await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter));
        baseDelay *= 2;
      }
    }
    throw lastError || new Error(`Rillnet call failed after ${this.maxRetries} attempts`);
  }

  /**
   * Resilient download of snapshot buffer with URL refresh, backoff jitter, and overall deadline enforcement
   */
  async acquireResilientSnapshot(providedUrl?: string): Promise<RillnetAcquireResult> {
    const totalStart = performance.now();
    let attempts = 0;
    let urlRefreshes = 0;
    let currentUrl = providedUrl || "";
    let currentUpdatedAt = new Date().toISOString();
    let lastError: RillnetDownloadError | null = null;
    let baseDelay = Math.min(this.timeoutMs / 2, 1000);

    // If no URL provided initially, request one
    if (!currentUrl) {
      const tUrl = await this.requestSnapshotUrl();
      currentUrl = tUrl.downloadUrl;
      currentUpdatedAt = tUrl.updatedAt;
    }

    while (attempts < this.maxRetries) {
      attempts++;
      const elapsedMs = Math.round(performance.now() - totalStart);
      const remainingDeadlineMs = this.totalDeadlineMs - elapsedMs;

      if (remainingDeadlineMs <= 0) {
        lastError = new RillnetDownloadError(
          RillnetErrorCode.TOTAL_DOWNLOAD_DEADLINE_EXCEEDED,
          `Rillnet acquisition exceeded total deadline of ${this.totalDeadlineMs}ms`
        );
        break;
      }

      const attemptTimeoutMs = Math.min(this.timeoutMs, remainingDeadlineMs);
      const attemptStart = performance.now();

      try {
        const buffer = await this.executeSingleAttempt(
          currentUrl,
          {},
          async (res) => await res.arrayBuffer(),
          attemptTimeoutMs
        );

        const durationMs = Math.round(performance.now() - attemptStart);
        const totalDurationMs = Math.round(performance.now() - totalStart);

        const sanitizeUrl = (u: string) => u.split("?")[0];
        logger.info({
          component: "RillnetClient",
          operation: "downloadSnapshot",
          status: "success",
          message: `[ RillnetDownload ] attempt=${attempts} stage=body durationMs=${durationMs} status=success bytes=${buffer.byteLength} urlRefreshed=false remainingDeadlineMs=${this.totalDeadlineMs - totalDurationMs}`,
          durationMs,
          metadata: {
            attempt: attempts,
            retryCount: attempts - 1,
            urlRefreshCount: urlRefreshes,
            bytes: buffer.byteLength,
            remainingDeadlineMs: this.totalDeadlineMs - totalDurationMs,
          },
        });
        logger.info({
          component: "RillnetClient",
          operation: "downloadSnapshot",
          status: "success",
          message: `[ RillnetDownload Summary ] attempts=${attempts} | urlRefreshes=${urlRefreshes} | totalDurationMs=${totalDurationMs} | downloadBytes=${buffer.byteLength} | result=success | finalErrorCode=none`,
          durationMs: totalDurationMs,
          metadata: {
            attempts,
            urlRefreshes,
            downloadBytes: buffer.byteLength,
            finalErrorCode: "none",
          },
        });

        this.lastSuccessAt = new Date().toISOString();
        return {
          buffer,
          downloadUrl: sanitizeUrl(currentUrl),
          updatedAt: currentUpdatedAt,
          attempts,
          urlRefreshes,
          totalDurationMs,
        };
      } catch (err: any) {
        const durationMs = Math.round(performance.now() - attemptStart);
        const downloadErr: RillnetDownloadError =
          err instanceof RillnetDownloadError
            ? err
            : new RillnetDownloadError(RillnetErrorCode.HTTP_RETRYABLE, err?.message || String(err), undefined, err);

        lastError = downloadErr;
        this.lastFailureAt = new Date().toISOString();
        this.lastErrorReason = downloadErr.message;

        const { isRetryable } = this.classifyError(downloadErr, true);

        // Check if signed URL expired/invalid and can be refreshed
        if (downloadErr.code === RillnetErrorCode.SIGNED_URL_EXPIRED_OR_INVALID && urlRefreshes < this.maxUrlRefreshes) {
          urlRefreshes++;
          const remMs = Math.max(0, this.totalDeadlineMs - Math.round(performance.now() - totalStart));
          logger.warn({
            component: "RillnetClient",
            operation: "downloadSnapshot",
            status: "retry",
            message: `[ RillnetDownload ] attempt=${attempts} stage=url durationMs=${durationMs} status=retry errorCode=${downloadErr.code} urlRefreshed=true remainingDeadlineMs=${remMs}`,
            durationMs,
            errorCode: downloadErr.code,
            metadata: {
              attempt: attempts,
              retryCount: attempts - 1,
              urlRefreshed: true,
              remainingDeadlineMs: remMs,
            },
          });

          try {
            const fresh = await this.requestSnapshotUrl();
            currentUrl = fresh.downloadUrl;
            currentUpdatedAt = fresh.updatedAt;
            continue; // Immediately retry with fresh URL
          } catch (urlErr: any) {
            logger.warn({
              component: "RillnetClient",
              operation: "requestSnapshotUrl",
              status: "error",
              message: `[ RillnetDownload ] URL refresh failed: ${urlErr?.message || String(urlErr)}`,
              error: urlErr,
            });
          }
        }

        // Non-retryable error fails immediately
        if (!isRetryable) {
          const remMs = Math.max(0, this.totalDeadlineMs - Math.round(performance.now() - totalStart));
          logger.error({
            component: "RillnetClient",
            operation: "downloadSnapshot",
            status: "failed",
            message: `[ RillnetDownload ] attempt=${attempts} stage=body durationMs=${durationMs} status=failed errorCode=${downloadErr.code} urlRefreshed=false remainingDeadlineMs=${remMs}`,
            durationMs,
            errorCode: downloadErr.code,
            error: downloadErr,
            metadata: {
              attempt: attempts,
              remainingDeadlineMs: remMs,
            },
          });
          break;
        }

        const currentElapsed = Math.round(performance.now() - totalStart);
        const currentRemaining = this.totalDeadlineMs - currentElapsed;

        if (attempts >= this.maxRetries || currentRemaining <= 0) {
          const finalCode = currentRemaining <= 0 ? RillnetErrorCode.TOTAL_DOWNLOAD_DEADLINE_EXCEEDED : downloadErr.code;
          logger.error({
            component: "RillnetClient",
            operation: "downloadSnapshot",
            status: "failed",
            message: `[ RillnetDownload ] attempt=${attempts} stage=body durationMs=${durationMs} status=failed errorCode=${finalCode} urlRefreshed=false remainingDeadlineMs=${Math.max(0, currentRemaining)}`,
            durationMs,
            errorCode: finalCode,
            error: downloadErr,
            metadata: {
              attempt: attempts,
              remainingDeadlineMs: Math.max(0, currentRemaining),
            },
          });
          break;
        }

        // Exponential backoff with jitter bounded by remaining deadline
        const jitter = Math.random() * 50;
        const delayMs = Math.min(baseDelay + jitter, currentRemaining);
        baseDelay *= 2;

        logger.warn({
          component: "RillnetClient",
          operation: "downloadSnapshot",
          status: "retry",
          message: `[ RillnetDownload ] attempt=${attempts} stage=body durationMs=${durationMs} status=retry errorCode=${downloadErr.code} bytes=0 urlRefreshed=false remainingDeadlineMs=${currentRemaining}`,
          durationMs,
          errorCode: downloadErr.code,
          metadata: {
            attempt: attempts,
            bytes: 0,
            remainingDeadlineMs: currentRemaining,
          },
        });

        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    const totalDurationMs = Math.round(performance.now() - totalStart);
    const finalErr =
      lastError ||
      new RillnetDownloadError(RillnetErrorCode.TOTAL_DOWNLOAD_DEADLINE_EXCEEDED, "Rillnet acquisition failed");

    logger.error({
      component: "RillnetClient",
      operation: "downloadSnapshot",
      status: "failed",
      message: `[ RillnetDownload Summary ] attempts=${attempts} | urlRefreshes=${urlRefreshes} | totalDurationMs=${totalDurationMs} | downloadBytes=0 | result=failed | finalErrorCode=${finalErr.code}`,
      durationMs: totalDurationMs,
      errorCode: finalErr.code,
      error: finalErr,
      metadata: {
        attempts,
        urlRefreshes,
        downloadBytes: 0,
        finalErrorCode: finalErr.code,
      },
    });

    throw finalErr;
  }

  /**
   * Request snapshot download URL
   */
  async requestSnapshotUrl(): Promise<RillnetSnapshotUrlDTO> {
    try {
      const data = await this.executeWithRetry(
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
            throw new RillnetDownloadError(
              RillnetErrorCode.MALFORMED_SNAPSHOT,
              `Malformed JSON response body: ${jsonErr.message}`,
              undefined,
              jsonErr
            );
          }
        }
      );

      const downloadUrl = data.liveUrl || data.url;
      if (!downloadUrl || typeof downloadUrl !== "string") {
        throw new RillnetDownloadError(
          RillnetErrorCode.MALFORMED_SNAPSHOT,
          "Response did not contain a valid snapshot download URL"
        );
      }

      let resolvedDownloadUrl: string;
      try {
        resolvedDownloadUrl = new URL(downloadUrl, this.endpointApi).toString();
      } catch (urlError: any) {
        throw new RillnetDownloadError(
          RillnetErrorCode.MALFORMED_SNAPSHOT,
          `Response contained an invalid snapshot download URL: ${urlError.message}`,
          undefined,
          urlError
        );
      }

      return {
        downloadUrl: resolvedDownloadUrl,
        updatedAt: data.liveUpdated || data.updated || new Date().toISOString(),
      };
    } catch (err: any) {
      this.lastFailureAt = new Date().toISOString();
      this.lastErrorReason = err.message;
      throw err;
    }
  }

  /**
   * Downloads snapshot data with resilience
   */
  async downloadSnapshot(url: string): Promise<ArrayBuffer> {
    try {
      const result = await this.acquireResilientSnapshot(url);
      return result.buffer;
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
      return await this.executeWithRetry(
        this.endpointMeta,
        {},
        async (res) => {
          try {
            return await res.json();
          } catch (jsonErr: any) {
            throw new RillnetDownloadError(
              RillnetErrorCode.MALFORMED_SNAPSHOT,
              `Malformed metadata JSON: ${jsonErr.message}`,
              undefined,
              jsonErr
            );
          }
        }
      );
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
