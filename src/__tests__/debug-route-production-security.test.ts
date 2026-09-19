import { afterEach, describe, expect, it, vi } from "vitest";

describe("production debug routes", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("does not expose Rillnet sample orders in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { GET } = await import("@/app/api/debug/rillnet/route");
    const response = await GET();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("does not expose sync metadata in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { GET } = await import("@/app/api/debug/sync-runs/route");
    const response = await GET();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
  });
});
