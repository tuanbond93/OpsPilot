/** Generic composition proof: shadow failure is swallowed after V1 has returned its result. */
export async function runV1WithIsolatedShadow<T>(runV1: () => Promise<T>, runShadow: (v1: T) => Promise<void>): Promise<{ v1: T; shadowFailed: boolean }> {
  const v1 = await runV1(); try { await runShadow(v1); return { v1, shadowFailed: false }; } catch { return { v1, shadowFailed: true }; }
}
/** Append-only in-memory model used solely by tests/local fixtures; callers cannot replace historical rows. */
export function appendObservation<T extends { snapshotId: string }>(existing: readonly T[], next: T): readonly T[] { if (existing.some(item => item.snapshotId === next.snapshotId)) throw new Error("DUPLICATE_SNAPSHOT_ID"); return Object.freeze([...existing, Object.freeze({ ...next })]); }
