// src/workflow/RetryPolicy.ts
/**
 * Simple exponential backoff retry utility.
 */
export class RetryPolicy {
  /**
   * Checks if an error is considered retryable.
   */
  static isRetryableWorkflowError(err: unknown): boolean {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      // Retryable transient errors
      if (msg.includes('timeout') || msg.includes('network') || msg.includes('temporar')) {
        return true;
      }
      // Explicitly non‑retryable
      if (msg.includes('validation') || msg.includes('cancelled') || msg.includes('invalid') || msg.includes('business') || msg.includes('planner')) {
        return false;
      }
    }
    // Default: not retryable
    return false;
  }

  

  /**
   * Executes an async function with retries and exponential backoff.
   * @param fn The async function to execute.
   * @param retries Number of attempts (default 3).
   * @param baseDelayMs Base delay in ms for the first retry (default 200).
   * @returns The result of the async function.
   * @throws The last encountered error if all retries fail.
   */
  static async retry<T>(fn: () => Promise<T>, retries = 3, baseDelayMs = 200): Promise<T> {
    let attempt = 0;
    let lastError: unknown;
    while (attempt < retries) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (!this.isRetryableWorkflowError(err)) {
          throw err;
        }
        attempt++;
        if (attempt >= retries) break;
        const delay = baseDelayMs * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }
}
