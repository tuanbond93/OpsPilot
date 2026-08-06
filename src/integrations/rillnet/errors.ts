export enum RillnetErrorCode {
  CONNECTION_TIMEOUT = "CONNECTION_TIMEOUT",
  RESPONSE_BODY_TIMEOUT = "RESPONSE_BODY_TIMEOUT",
  HTTP_RETRYABLE = "HTTP_RETRYABLE",
  HTTP_NON_RETRYABLE = "HTTP_NON_RETRYABLE",
  SIGNED_URL_EXPIRED_OR_INVALID = "SIGNED_URL_EXPIRED_OR_INVALID",
  MALFORMED_SNAPSHOT = "MALFORMED_SNAPSHOT",
  DECOMPRESSION_FAILED = "DECOMPRESSION_FAILED",
  TOTAL_DOWNLOAD_DEADLINE_EXCEEDED = "TOTAL_DOWNLOAD_DEADLINE_EXCEEDED",
}

export class RillnetDownloadError extends Error {
  constructor(
    public readonly code: RillnetErrorCode,
    message: string,
    public readonly status?: number,
    cause?: any
  ) {
    super(message, { cause });
    this.name = "RillnetDownloadError";
  }
}
