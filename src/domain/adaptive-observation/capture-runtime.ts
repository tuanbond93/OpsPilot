import type { ShadowFeatureFlags } from "./contracts";
import { AdaptiveObservationAssembler, type ObservationQualityCounters, type Release1CaseEvidence, qualityCounters } from "./assembler";
import type { AdaptiveObservationWriter } from "./writer";
export const OBSERVATION_CAPTURE_TIMEOUT_MS = 500;
export type ObservationCaptureResult = { attempts: number; snapshotsGenerated: number; snapshotFailures: number; populationFailures: number; counters: ObservationQualityCounters };
/** Server-only observability capture. No V2 import, notification, incident, or follow-up dependency. */
export async function captureRelease1Observation(input: { flags: ShadowFeatureFlags; cases: Release1CaseEvidence[]; writer: Pick<AdaptiveObservationWriter, "appendSnapshot" | "appendCheckpointPopulation">; timeoutMs?: number }): Promise<ObservationCaptureResult> {
  const empty = qualityCounters([]); if (!input.flags.SHADOW_SNAPSHOT_WRITE_ENABLED) return { attempts: 0, snapshotsGenerated: 0, snapshotFailures: 0, populationFailures: 0, counters: empty };
  const assembler = new AdaptiveObservationAssembler(); const snapshots = input.cases.map(item => assembler.assemble(item)); let snapshotFailures = 0; let populationFailures = 0; const budget = input.timeoutMs ?? OBSERVATION_CAPTURE_TIMEOUT_MS;
  await Promise.race([Promise.all(input.cases.map(async (item, index) => { try { await input.writer.appendSnapshot(snapshots[index]); } catch { snapshotFailures++; return; } try { await input.writer.appendCheckpointPopulation(assembler.population(item)); } catch { populationFailures++; } })), new Promise<void>((_, reject) => setTimeout(() => reject(new Error("OBSERVATION_CAPTURE_TIMEOUT")), budget))]).catch(() => { snapshotFailures += Math.max(1, input.cases.length - snapshotFailures); });
  const counters = qualityCounters(snapshots); counters.SNAPSHOT_FAILED = snapshotFailures; counters.SNAPSHOT_SUCCEEDED = Math.max(0, snapshots.length - snapshotFailures); counters.POPULATION_SNAPSHOT_FAILED = populationFailures; counters.POPULATION_SNAPSHOT_SUCCEEDED = Math.max(0, snapshots.length - populationFailures);
  return { attempts: input.cases.length, snapshotsGenerated: snapshots.length, snapshotFailures, populationFailures, counters };
}
