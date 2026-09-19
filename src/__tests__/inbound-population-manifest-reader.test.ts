import { describe, expect, it } from "vitest";
import { InboundEvidenceService } from "@/domain/near-term-capacity/inbound-evidence-service";

function dbForManifest(manifest: Record<string, unknown> | null, observationCount = 0) {
  const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const builder = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const result = () => {
      if (table === "sync_runs") return { data: { id: "sync-latest", started_at: "2026-09-19T03:00:00.000Z" }, error: null };
      if (table === "inbound_population_manifests") return { data: manifest, error: null };
      if (table === "inbound_order_observations") {
        if (filters.some(([field]) => field === "source_system") && filters.some(([field]) => field === "sync_run_id")) {
          return { count: observationCount, error: null };
        }
        return { data: [], error: null };
      }
      return { data: null, error: null };
    };
    const query: any = {
      select: () => query,
      eq: (field: string, value: unknown) => { filters.push([field, value]); return query; },
      or: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: async () => result(),
      range: async () => result(),
      then: (resolve: (value: unknown) => unknown) => resolve(result()),
    };
    calls.push({ table, filters });
    return query;
  };
  return { db: { from: builder } as any, calls };
}

describe("inbound population manifest reader contract", () => {
  it.each([
    [null, "missing"],
    [{ population_status: "STARTED", expected_observation_count: 2, persisted_observation_count: 1 }, "partial"],
    [{ population_status: "FAILED", expected_observation_count: 2, persisted_observation_count: 1 }, "failed"],
    [{ population_status: "COMPLETE", expected_observation_count: 2, persisted_observation_count: 1 }, "unreconciled"],
  ])("returns UNAVAILABLE for %s population", async (manifest, _label) => {
    const { db } = dbForManifest(manifest as any, 1);
    const snapshot = await new InboundEvidenceService(db).computeReplayInboundEvidence("TARGET", "Target", "2026-09-19T10:00:00+07:00");
    expect(snapshot.status).toBe("UNAVAILABLE");
    expect(snapshot.diagnostics?.error).toContain("NO_COMPLETE_INBOUND_POPULATION");
  });

  it("uses only the latest successful run's complete manifest and never falls back across runs", async () => {
    const { db, calls } = dbForManifest({ population_status: "COMPLETE", expected_observation_count: 0, persisted_observation_count: 0 }, 0);
    const snapshot = await new InboundEvidenceService(db).computeReplayInboundEvidence("TARGET", "Target", "2026-09-19T10:00:00+07:00");
    expect(snapshot.status).toBe("AVAILABLE");
    const observationFilters = calls.filter((call) => call.table === "inbound_order_observations").flatMap((call) => call.filters);
    expect(observationFilters).toContainEqual(["sync_run_id", "sync-latest"]);
  });
});
