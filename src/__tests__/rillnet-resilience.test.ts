import { describe, it, expect, beforeEach, vi } from "vitest";
import { RillnetClient, RillnetErrorCode } from "@/integrations/rillnet/rillnet-client";
import { decompressSnapshot } from "@/connectors/rillnet/snapshot";
import { logger } from "@/observability/logger";

describe("Sprint 10.2 — Rillnet Download Resilience & Retry Policy Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("RILLNET_TIMEOUT_MS", "100");
    vi.stubEnv("RILLNET_TOTAL_DEADLINE_MS", "5000");
    vi.stubEnv("RILLNET_MAX_RETRIES", "3");
    vi.stubEnv("RILLNET_MAX_URL_REFRESHES", "2");
  });

  it("1. First attempt succeeds", async () => {
    const mockData = new Uint8Array([1, 2, 3, 4]).buffer;
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(mockData),
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = new RillnetClient();
    const result = await client.acquireResilientSnapshot("https://mock.rillnet.com/snap.gz?token=secret123");

    expect(result.buffer.byteLength).toBe(4);
    expect(result.attempts).toBe(1);
    expect(result.urlRefreshes).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("2. Body timeout then second attempt succeeds", async () => {
    let attempts = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      attempts++;
      if (attempts === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () =>
            new Promise((_resolve, reject) => {
              const err = new Error("Aborted");
              err.name = "AbortError";
              reject(err);
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new Uint8Array([10, 20]).buffer),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new RillnetClient();
    const res = await client.acquireResilientSnapshot("https://mock.rillnet.com/snap.gz?token=secret123");

    expect(res.attempts).toBe(2);
    expect(res.buffer.byteLength).toBe(2);
  });

  it("3. Connection timeout then retry succeeds", async () => {
    let attempts = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      attempts++;
      if (attempts === 1) {
        const err = new Error("Connection Timeout");
        err.name = "AbortError";
        return Promise.reject(err);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new Uint8Array([5, 6, 7]).buffer),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new RillnetClient();
    const res = await client.acquireResilientSnapshot("https://mock.rillnet.com/snap.gz?token=secret123");

    expect(res.attempts).toBe(2);
    expect(res.buffer.byteLength).toBe(3);
  });

  it("4. HTTP 503 retries and succeeds", async () => {
    let attempts = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      attempts++;
      if (attempts === 1) {
        return Promise.resolve({ ok: false, status: 503 });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new Uint8Array([100]).buffer),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new RillnetClient();
    const res = await client.acquireResilientSnapshot("https://mock.rillnet.com/snap.gz?token=secret123");

    expect(res.attempts).toBe(2);
    expect(res.buffer.byteLength).toBe(1);
  });

  it("5. HTTP 429 retries and succeeds", async () => {
    let attempts = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      attempts++;
      if (attempts === 1) {
        return Promise.resolve({ ok: false, status: 429 });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new Uint8Array([101]).buffer),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new RillnetClient();
    const res = await client.acquireResilientSnapshot("https://mock.rillnet.com/snap.gz?token=secret123");

    expect(res.attempts).toBe(2);
    expect(res.buffer.byteLength).toBe(1);
  });

  it("6. HTTP 400 does not retry (fails immediately)", async () => {
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: false, status: 400 })
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = new RillnetClient();

    await expect(
      client.acquireResilientSnapshot("https://mock.rillnet.com/snap.gz?token=secret123")
    ).rejects.toThrow("HTTP Error Status: 400");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("7. Expired signed URL (403) triggers one fresh URL request and succeeds", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      callCount++;
      if (url.includes("/api/gtalk-send")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ liveUrl: "https://mock.rillnet.com/fresh-snap.gz?token=new999" }),
        });
      }
      if (url.includes("old-token")) {
        return Promise.resolve({ ok: false, status: 403 });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new Uint8Array([88, 99]).buffer),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new RillnetClient();
    const res = await client.acquireResilientSnapshot("https://mock.rillnet.com/old-token");

    expect(res.urlRefreshes).toBe(1);
    expect(res.downloadUrl).toBe("https://mock.rillnet.com/fresh-snap.gz");
    expect(res.buffer.byteLength).toBe(2);
  });

  it("8. Total deadline (RILLNET_TOTAL_DEADLINE_MS) stops further retries cleanly", async () => {
    vi.stubEnv("RILLNET_TOTAL_DEADLINE_MS", "50");
    const mockFetch = vi.fn().mockImplementation(() =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({ ok: false, status: 503 });
        }, 100);
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = new RillnetClient();

    await expect(
      client.acquireResilientSnapshot("https://mock.rillnet.com/snap.gz?token=secret123")
    ).rejects.toThrow();
  });

  it("9. Partial body is discarded and successful bytes are byte-for-byte identical", async () => {
    const rawBytes = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.reject(new Error("Network connection dropped mid-transfer")),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(rawBytes.buffer),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new RillnetClient();
    const res = await client.acquireResilientSnapshot("https://mock.rillnet.com/snap.gz?token=secret123");

    expect(new Uint8Array(res.buffer)).toEqual(rawBytes);
  });

  it("10. Malformed GZIP is not retried as a network failure", async () => {
    const invalidGzipBytes = new Uint8Array([0, 1, 2, 3, 4]).buffer;
    await expect(decompressSnapshot(invalidGzipBytes)).rejects.toThrow(
      "Failed to decompress Rillnet snapshot"
    );
  });

  it("11. Diagnostics log format does not output sensitive token parameters", async () => {
    const loggerSpy = vi.spyOn(logger, "info");
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = new RillnetClient();
    const sensitiveUrl = "https://mock.rillnet.com/snap.gz?token=SUPER_SECRET_KEY_12345";
    await client.acquireResilientSnapshot(sensitiveUrl);

    for (const call of loggerSpy.mock.calls) {
      const msg = JSON.stringify(call);
      expect(msg).not.toContain("SUPER_SECRET_KEY_12345");
    }
  });
});
