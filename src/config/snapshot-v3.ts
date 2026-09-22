/** V3 is deliberately opt-in. It has no effect unless explicitly enabled. */
export const SNAPSHOT_V3_SHADOW_ENV = "SNAPSHOT_V3_SHADOW_ENABLED" as const;
export const SNAPSHOT_V3_SUPABASE_URL_ENV = "SNAPSHOT_V3_SUPABASE_URL" as const;
export const SNAPSHOT_V3_SUPABASE_SERVICE_ROLE_KEY_ENV = "SNAPSHOT_V3_SUPABASE_SERVICE_ROLE_KEY" as const;

export function isSnapshotV3ShadowEnabled(): boolean {
  return process.env[SNAPSHOT_V3_SHADOW_ENV] === "true";
}
