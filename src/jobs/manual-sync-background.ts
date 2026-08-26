import type { SyncJobResult } from "@/jobs/sync-rillnet";
import { syncRillnet } from "@/jobs/sync-rillnet";

export type ManualSyncState = {
  status: "idle" | "running" | "success" | "failed";
  requestedAt: string | null;
  completedAt: string | null;
  result: SyncJobResult | null;
};

type ManualSyncRegistry = ManualSyncState & { task: Promise<void> | null };

const registryKey = "__opspilotManualSyncRegistry";
const runtime = globalThis as typeof globalThis & {
  [registryKey]?: ManualSyncRegistry;
};

function getRegistry(): ManualSyncRegistry {
  if (!runtime[registryKey]) {
    runtime[registryKey] = {
      status: "idle",
      requestedAt: null,
      completedAt: null,
      result: null,
      task: null,
    };
  }
  return runtime[registryKey];
}

export function getManualSyncState(): ManualSyncState {
  const { task: _task, ...state } = getRegistry();
  return state;
}

export function startManualSync(): { accepted: boolean; state: ManualSyncState } {
  const registry = getRegistry();
  if (registry.status === "running") {
    return { accepted: false, state: getManualSyncState() };
  }

  registry.status = "running";
  registry.requestedAt = new Date().toISOString();
  registry.completedAt = null;
  registry.result = null;
  // A manual sync is an explicit operator request to rebuild derived evidence.
  // It must not stop at SOURCE_UNCHANGED because schema/rule upgrades may need
  // to backfill the same source snapshot without waiting for a new Rillnet file.
  registry.task = syncRillnet({ forceReprocessSource: true })
    .then((result) => {
      registry.result = result;
      registry.status = result.ok ? "success" : "failed";
      registry.completedAt = result.completedAt || new Date().toISOString();
    })
    .catch((error: unknown) => {
      const completedAt = new Date().toISOString();
      registry.result = {
        ok: false,
        syncRunId: "",
        startedAt: registry.requestedAt || completedAt,
        completedAt,
        durationMs: 0,
        fetchedOrderCount: 0,
        normalizedOrderCount: 0,
        incidentCount: 0,
        phaseTimings: {},
        dbInstrumentation: { totalQueries: 0, phases: {}, bottlenecksDetected: [] },
        error: {
          code: error instanceof Error ? error.name : "ManualSyncError",
          message: error instanceof Error ? error.message : String(error),
        },
      };
      registry.status = "failed";
      registry.completedAt = completedAt;
    })
    .finally(() => {
      registry.task = null;
    });

  return { accepted: true, state: getManualSyncState() };
}
