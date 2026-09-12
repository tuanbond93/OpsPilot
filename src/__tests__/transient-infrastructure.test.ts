import { describe, expect, it, vi } from "vitest";
import { isTransientInfrastructureError, retryTransientInfrastructure } from "@/services/transient-infrastructure";

describe("checkpoint transient infrastructure retry", () => {
  const immediate = async () => undefined;

  it("1. succeeds on the first lock attempt", async () => {
    const operation = vi.fn().mockResolvedValue({ acquired: true });
    const result = await retryTransientInfrastructure<{ acquired: boolean }>(operation, { sleep: immediate, random: () => 0.5 });
    expect(result.value.acquired).toBe(true);
    expect(result.telemetry).toEqual({ attempts: 1, retryCount: 0, finalStatus: "SUCCESS" });
  });

  it("2. retries a 504 then succeeds", async () => {
    const operation = vi.fn().mockRejectedValueOnce({ message: "HTTP 504 Gateway Timeout" }).mockResolvedValue("ok");
    const result = await retryTransientInfrastructure(operation, { sleep: immediate, random: () => 0.5 });
    expect(result.value).toBe("ok");
    expect(result.telemetry).toEqual({ attempts: 2, retryCount: 1, finalStatus: "SUCCESS" });
  });

  it("3. retries two transient failures then succeeds", async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error("Gateway Timeout")).mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValue("ok");
    const result = await retryTransientInfrastructure(operation, { sleep: immediate, random: () => 0.5 });
    expect(result.telemetry).toEqual({ attempts: 3, retryCount: 2, finalStatus: "SUCCESS" });
  });

  it("4. stops after three transient failures", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("upstream timeout"));
    await expect(retryTransientInfrastructure(operation, { sleep: immediate, random: () => 0.5 })).rejects.toMatchObject({
      transientRetryTelemetry: { attempts: 3, retryCount: 2, finalStatus: "TRANSIENT_FAILURE" },
    });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("5. never retries authentication failures", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("401 auth failure"));
    await expect(retryTransientInfrastructure(operation, { sleep: immediate })).rejects.toThrow("401 auth failure");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("6. treats a legitimate held lock as non-transient", async () => {
    expect(isTransientInfrastructureError({ code: "SYNC_ALREADY_RUNNING", message: "lock held" })).toBe(false);
    const operation = vi.fn().mockResolvedValue({ acquired: false });
    const result = await retryTransientInfrastructure(operation, { sleep: immediate });
    expect(result.telemetry.retryCount).toBe(0);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
