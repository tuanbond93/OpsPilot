/** V3 is deliberately opt-in. It has no effect unless explicitly enabled. */
export const SNAPSHOT_V3_SHADOW_ENV = "SNAPSHOT_V3_SHADOW_ENABLED" as const;

export function isSnapshotV3ShadowEnabled(): boolean {
  return process.env[SNAPSHOT_V3_SHADOW_ENV] === "true";
}
