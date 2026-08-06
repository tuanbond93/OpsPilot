export interface RetryConfig {
  maxRetry: number;
  backoffSeconds: number[];
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetry: 3,
  backoffSeconds: [30, 60, 120],
};

export class RetryEngine {
  /**
   * Classifies whether an error is transient (retriable) or permanent (non-retriable)
   */
  static isTransientError(statusCode?: number, errorCode?: string, errorMessage?: string): boolean {
    const code = (errorCode || "").toUpperCase();
    const msg = (errorMessage || "").toLowerCase();

    // Permanent auth / input errors
    if (statusCode === 400 || statusCode === 401 || statusCode === 403 || statusCode === 404) {
      return false;
    }

    if (
      code.includes("INVALID_TOKEN") ||
      code.includes("CHAT_NOT_FOUND") ||
      msg.includes("unauthorized") ||
      msg.includes("bad request") ||
      msg.includes("forbidden") ||
      msg.includes("chat not found")
    ) {
      return false;
    }

    // Retriable rate limits & server errors
    if (statusCode === 429 || (statusCode && statusCode >= 500 && statusCode <= 599)) {
      return true;
    }

    // Retriable network timeouts
    if (
      code.includes("TIMEOUT") ||
      code.includes("ECONNRESET") ||
      code.includes("ETIMEDOUT") ||
      msg.includes("timeout") ||
      msg.includes("fetch failed") ||
      msg.includes("network error")
    ) {
      return true;
    }

    // Default to non-transient for unknown permanent failures
    return false;
  }

  /**
   * Calculates backoff delay in milliseconds, respecting custom retryAfterSeconds if specified
   */
  static getNextRetryDelayMs(
    retryCount: number,
    retryAfterSeconds?: number,
    config: RetryConfig = DEFAULT_RETRY_CONFIG
  ): number {
    if (retryAfterSeconds && retryAfterSeconds > 0) {
      return retryAfterSeconds * 1000;
    }

    const index = Math.min(retryCount, config.backoffSeconds.length - 1);
    const delaySec = config.backoffSeconds[index] || 30;
    return delaySec * 1000;
  }

  /**
   * Evaluates if an action should be retried
   */
  static shouldRetry(
    retryCount: number,
    statusCode?: number,
    errorCode?: string,
    errorMessage?: string,
    maxRetry: number = DEFAULT_RETRY_CONFIG.maxRetry
  ): boolean {
    if (retryCount >= maxRetry) return false;
    return this.isTransientError(statusCode, errorCode, errorMessage);
  }
}
