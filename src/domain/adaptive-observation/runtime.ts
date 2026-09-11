import type { ShadowFeatureFlags } from "./contracts";

export type ShadowExecutionMode = "DISABLED" | "SNAPSHOT_ONLY" | "FULL_SHADOW";
export function shadowExecutionMode(flags: ShadowFeatureFlags): ShadowExecutionMode {
  if (!flags.SHADOW_SNAPSHOT_WRITE_ENABLED) return "DISABLED";
  return flags.ADAPTIVE_V2_SHADOW_ENABLED ? "FULL_SHADOW" : "SNAPSHOT_ONLY";
}
/** Fire-and-forget composition model; deliberately not wired into V1 in this change. */
export async function executeV1FailOpen<T>(runV1: () => Promise<T>, mode: ShadowExecutionMode, runShadow: (mode: Exclude<ShadowExecutionMode, "DISABLED">, v1: T) => Promise<void>, auditShadowFailure: (error: unknown) => void, timeoutMs = 1_000): Promise<T> {
  const v1 = await runV1();
  if (mode === "DISABLED") return v1;
  void Promise.race([runShadow(mode, v1), new Promise<void>((_, reject) => setTimeout(() => reject(new Error("SHADOW_TIMEOUT")), timeoutMs))]).catch(auditShadowFailure);
  return v1;
}
