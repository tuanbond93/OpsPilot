import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CheckpointShadowRunner } from "@/engine/checkpoint-v2/checkpoint-shadow-runner";

describe("Checkpoint Pipeline V2 - Route Integration & Kill-Switch", () => {
  const originalEnv = process.env.CHECKPOINT_PIPELINE_V2_SHADOW;

  afterEach(() => {
    process.env.CHECKPOINT_PIPELINE_V2_SHADOW = originalEnv;
  });

  it("isShadowEnabled returns false when env is undefined or false", () => {
    delete process.env.CHECKPOINT_PIPELINE_V2_SHADOW;
    expect(CheckpointShadowRunner.isShadowEnabled()).toBe(false);

    process.env.CHECKPOINT_PIPELINE_V2_SHADOW = "false";
    expect(CheckpointShadowRunner.isShadowEnabled()).toBe(false);
  });

  it("isShadowEnabled returns true only when env is explicitly 'true'", () => {
    process.env.CHECKPOINT_PIPELINE_V2_SHADOW = "true";
    expect(CheckpointShadowRunner.isShadowEnabled()).toBe(true);
  });
});
