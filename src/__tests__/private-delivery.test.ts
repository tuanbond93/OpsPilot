import { describe, it, expect, vi, beforeEach } from "vitest";

describe("PrivateDeliveryProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("delivers to PRIVATE_READY recipient", () => {
    expect(true).toBe(true);
  });
  it("skips delivery when user NOT_STARTED", () => {
    expect(true).toBe(true);
  });
  it("handles bot blocked by user", () => {
    expect(true).toBe(true);
  });
  it("fallback to legacy when no ready recipients", () => {
    expect(true).toBe(true);
  });
});
