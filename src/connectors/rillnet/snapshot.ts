import { RillnetDecompressError } from "./types";
import { gunzipSync } from "zlib";

/**
 * Decompresses GZIP-compressed ArrayBuffer into raw JSON text string
 */
export async function decompressSnapshot(buffer: ArrayBuffer): Promise<string> {
  const uint8Array = new Uint8Array(buffer);

  // Strategy 1: Try Node.js zlib.gunzipSync (fast & reliable in server environment)
  try {
    const decompressedBuffer = gunzipSync(uint8Array);
    return decompressedBuffer.toString("utf-8");
  } catch {
    // Fallthrough to Web DecompressionStream or plain text fallback
  }

  // Strategy 2: Web DecompressionStream API
  if (typeof DecompressionStream !== "undefined") {
    try {
      const blob = new Blob([buffer]);
      const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
      return await new Response(stream).text();
    } catch {
      // Fallthrough
    }
  }

  // Strategy 3: Uncompressed text fallback
  try {
    const text = new TextDecoder("utf-8").decode(uint8Array);
    const trimmed = text.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      return text;
    }
  } catch {
    // Fallthrough
  }

  throw new RillnetDecompressError(
    "Failed to decompress Rillnet snapshot buffer using GZIP or plain text decoding"
  );
}
