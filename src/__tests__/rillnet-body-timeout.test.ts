import { describe, it, expect, beforeEach, vi } from "vitest";
import { RillnetClient } from "@/integrations/rillnet/rillnet-client";

describe("Sprint 10.1.1 — Rillnet Body Timeout & Resource Cleanup Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("RILLNET_TIMEOUT_MS", "100");
    vi.stubEnv("RILLNET_MAX_RETRIES", "2");
  });

  it("1. Headers arrive and body completes before timeout", async () => {
    const mockData = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(mockData),
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = new RillnetClient();
    const result = await client.downloadSnapshot("https://mock.rillnet.com/snap.gz");

    expect(result.byteLength).toBe(5);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("2. Headers arrive but body stalls beyond timeout (body timeout triggers AbortController)", async () => {
    let signalAborted = false;
    const mockFetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      const signal = opts.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          signalAborted = true;
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => {
              const err = new Error("Aborted");
              err.name = "AbortError";
              reject(err);
            }, 150);
          }),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new RillnetClient();

    await expect(client.downloadSnapshot("https://mock.rillnet.com/snap.gz")).rejects.toThrow(
      "response-body timeout"
    );
    expect(signalAborted).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2); // Retried maxRetries (2) times
  });

  it("3. Timer is cleared after successful body read", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ liveUrl: "https://mock.rillnet.com/live.gz", liveUpdated: "2026-08-06T00:00:00Z" }),
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = new RillnetClient();
    const res = await client.requestSnapshotUrl();

    expect(res.downloadUrl).toBe("https://mock.rillnet.com/live.gz");
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("3b. Relative snapshot URLs resolve against the configured Rillnet endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ liveUrl: "/api/opsfile?f=ops_live.json.gz", liveUpdated: "2026-08-23T00:00:00Z" }),
    }));
    const client = new RillnetClient();
    const result = await client.requestSnapshotUrl();
    expect(result.downloadUrl).toBe("https://rillnet-app.vercel.app/api/opsfile?f=ops_live.json.gz");
  });

  it("4. Timer is cleared after failed body read", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error("Parse error")),
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = new RillnetClient();

    await expect(client.requestSnapshotUrl()).rejects.toThrow("Malformed JSON");
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("5. Retries occur after a body-read timeout according to existing policy", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      callCount++;
      if (callCount === 1) {
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
    const buf = await client.downloadSnapshot("https://mock.rillnet.com/snap.gz");

    expect(callCount).toBe(2);
    expect(buf.byteLength).toBe(2);
  });

  it("6. Final error preserves meaningful timeout context", async () => {
    const mockFetch = vi.fn().mockImplementation(() => {
      const err = new Error("Connection failed");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new RillnetClient();

    await expect(client.downloadSnapshot("https://mock.rillnet.com/snap.gz")).rejects.toThrow(
      "connection/header timeout"
    );
  });

  it("7. HTTP non-2xx status handling remains unchanged and cancels body stream", async () => {
    const cancelSpy = vi.fn().mockResolvedValue(undefined);
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        body: { cancel: cancelSpy },
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = new RillnetClient();

    await expect(client.downloadSnapshot("https://mock.rillnet.com/snap.gz")).rejects.toThrow(
      "HTTP Error Status: 500"
    );
    expect(cancelSpy).toHaveBeenCalled();
  });

  it("8. Successful snapshot download remains byte-for-byte compatible", async () => {
    const rawBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x12, 0x34]);
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(rawBytes.buffer),
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = new RillnetClient();
    const downloaded = await client.downloadSnapshot("https://mock.rillnet.com/snap.gz");

    const resultArr = new Uint8Array(downloaded);
    expect(resultArr).toEqual(rawBytes);
  });
});
