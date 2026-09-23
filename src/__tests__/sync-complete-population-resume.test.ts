import { afterEach, describe, expect, it, vi } from "vitest";
import { RillnetConnector } from "@/connectors/rillnet";
import type { SyncPhase } from "@/connectors/supabase/types";
import type {
  IInboundOrderObservationRepository,
  InboundOrderObservationRow,
  InboundPopulationManifest,
  InboundPopulationManifestInput,
} from "@/repositories/interfaces/IInboundOrderObservationRepository";
import type { IFollowupRepository } from "@/repositories/interfaces/IFollowupRepository";
import { MockIncidentRepository } from "@/repositories/mock/MockIncidentRepository";
import { MockSyncRunRepository } from "@/repositories/mock/MockSyncRunRepository";
import * as projectionEngine from "@/projections/projection-engine";
import { FollowupEngine } from "@/engine/followup";
import { SyncService } from "@/services/impl/SyncService";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const INCIDENT_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_FRESHNESS = "2026-09-22T11:00:00.000Z";
const SOURCE_ROWS = 10049;
const PERSISTED_PHASES: SyncPhase[] = [
  "CREATED",
  "FETCHING_SNAPSHOT",
  "PERSISTING_SNAPSHOTS",
  "PERSISTING_INCIDENTS",
  "PERSISTING_HISTORY",
];

function completeManifest(): InboundPopulationManifest {
  return {
    sync_run_id: RUN_ID,
    source_system: "RILLNET",
    population_status: "COMPLETE",
    normalized_population_count: SOURCE_ROWS,
    expected_observation_count: SOURCE_ROWS,
    persisted_observation_count: SOURCE_ROWS,
    duplicate_identical_count: 0,
    duplicate_conflict_count: 0,
    source_freshness: SOURCE_FRESHNESS,
    population_completed_at: "2026-09-22T11:01:00.000Z",
  };
}

class PopulationRepository implements IInboundOrderObservationRepository {
  manifest: InboundPopulationManifest | null = completeManifest();
  persistedCount = SOURCE_ROWS;
  manifestReads = 0;
  countReads = 0;
  replacements = 0;
  deletes = 0;
  inserts = 0;
  completions = 0;
  failures = 0;

  async getPopulationManifest(): Promise<InboundPopulationManifest | null> {
    this.manifestReads += 1;
    return this.manifest;
  }

  async replaceIncompletePopulation(input: InboundPopulationManifestInput): Promise<void> {
    this.replacements += 1;
    if (this.manifest?.population_status === "COMPLETE") {
      throw new Error("INBOUND_POPULATION_REPLACEMENT_FORBIDDEN_COMPLETED");
    }
    this.deletes += 1;
    this.persistedCount = 0;
    this.manifest = { ...input, population_status: "STARTED", persisted_observation_count: 0 };
  }

  async insertBatch(rows: InboundOrderObservationRow[]): Promise<number> {
    this.inserts += rows.length;
    this.persistedCount += rows.length;
    return rows.length;
  }

  async countPersisted(): Promise<number> {
    this.countReads += 1;
    return this.persistedCount;
  }

  async completePopulation(input: InboundPopulationManifestInput & { persisted_observation_count: number; population_completed_at: string }): Promise<void> {
    this.completions += 1;
    this.manifest = { ...input, population_status: "COMPLETE" };
  }

  async failPopulation(): Promise<void> {
    this.failures += 1;
    if (this.manifest && this.manifest.population_status !== "COMPLETE") {
      this.manifest.population_status = "FAILED";
    }
  }
}

async function failedParentRun(completedPhases: SyncPhase[] = PERSISTED_PHASES) {
  const repository = new MockSyncRunRepository();
  await repository.createSyncRun("2026-09-22T11:00:00.000Z", { id: RUN_ID });
  await repository.updatePhase(RUN_ID, completedPhases.at(-1) || "CREATED", completedPhases);
  await repository.updateFailed(RUN_ID, {
    completedAt: "2026-09-22T11:02:00.000Z",
    durationMs: 120000,
    errorCode: "SimulatedFailure",
    errorMessage: "Simulated interrupted run",
  });
  return repository;
}

function incidentRepository() {
  const repository = new MockIncidentRepository();
  repository.seed([{
    id: INCIDENT_ID,
    incident_key: "21600000:THIEU_SHIPPER",
    warehouse_id: "21600000",
    warehouse_name: "Warehouse",
    reason_code: "THIEU_SHIPPER",
    reason_name: "Thiếu shipper",
    status: "open",
    priority_score: 50,
    first_detected_at: SOURCE_FRESHNESS,
    last_detected_at: SOURCE_FRESHNESS,
    last_sync_run_id: RUN_ID,
  }]);
  return repository;
}

function sourceConnectorSpies() {
  return {
    fetch: vi.spyOn(RillnetConnector.prototype, "fetchSnapshotUrlOnly"),
    download: vi.spyOn(RillnetConnector.prototype, "downloadBufferOnly"),
    parse: vi.spyOn(RillnetConnector.prototype, "parseSnapshotFromBuffer"),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("completed inbound population resume", () => {
  it("reuses a COMPLETE population for a failed parent and continues at follow-up without source or population writes", async () => {
    vi.stubEnv("SNAPSHOT_V3_SHADOW_ENABLED", "false");
    const source = sourceConnectorSpies();
    const resumeFollowups = vi.spyOn(FollowupEngine.prototype, "processIncidentFollowups").mockResolvedValue([]);
    vi.spyOn(projectionEngine, "refresh").mockResolvedValue(undefined);
    const syncRuns = await failedParentRun();
    const population = new PopulationRepository();
    const service = new SyncService(syncRuns, null, incidentRepository(), null, null, {} as IFollowupRepository, null, null, null, null, null, null, population);

    const result = await service.runSync();

    expect(result.ok).toBe(true);
    expect(result.syncRunId).toBe(RUN_ID);
    expect(result.fetchedOrderCount).toBe(SOURCE_ROWS);
    expect(result.normalizedOrderCount).toBe(SOURCE_ROWS);
    expect(resumeFollowups).toHaveBeenCalledTimes(1);
    expect(source.fetch).not.toHaveBeenCalled();
    expect(source.download).not.toHaveBeenCalled();
    expect(source.parse).not.toHaveBeenCalled();
    expect(population.manifestReads).toBe(1);
    expect(population.countReads).toBe(1);
    expect(population.replacements).toBe(0);
    expect(population.deletes).toBe(0);
    expect(population.inserts).toBe(0);
    expect(population.completions).toBe(0);
    expect(population.failures).toBe(0);
    expect((await syncRuns.getLatestSyncRun())?.status).toBe("success");
  });

  it("keeps COMPLETE population retries idempotent across a failed finalization and retry", async () => {
    vi.stubEnv("SNAPSHOT_V3_SHADOW_ENABLED", "false");
    const source = sourceConnectorSpies();
    const resumeFollowups = vi.spyOn(FollowupEngine.prototype, "processIncidentFollowups").mockResolvedValue([]);
    vi.spyOn(projectionEngine, "refresh").mockResolvedValue(undefined);
    const syncRuns = await failedParentRun();
    const updateSuccess = vi.spyOn(syncRuns, "updateSuccess");
    updateSuccess.mockRejectedValueOnce(new Error("SIMULATED_FINALIZATION_INTERRUPTION"));
    const population = new PopulationRepository();
    const service = new SyncService(syncRuns, null, incidentRepository(), null, null, {} as IFollowupRepository, null, null, null, null, null, null, population);

    const firstAttempt = await service.runSync();
    const retry = await service.runSync();

    expect(firstAttempt.ok).toBe(false);
    expect(retry.ok).toBe(true);
    expect(retry.syncRunId).toBe(RUN_ID);
    expect(source.fetch).not.toHaveBeenCalled();
    expect(source.download).not.toHaveBeenCalled();
    expect(source.parse).not.toHaveBeenCalled();
    expect(population.manifestReads).toBe(2);
    expect(population.countReads).toBe(2);
    expect(population.replacements).toBe(0);
    expect(population.deletes).toBe(0);
    expect(population.inserts).toBe(0);
    expect(population.completions).toBe(0);
    expect(population.failures).toBe(0);
    expect(resumeFollowups).toHaveBeenCalledTimes(1);
  });

  it("preserves rebuild behavior for an incomplete population", async () => {
    vi.stubEnv("SNAPSHOT_V3_SHADOW_ENABLED", "false");
    const source = sourceConnectorSpies();
    source.fetch.mockResolvedValue({ downloadUrl: "snapshot-url", updatedAt: SOURCE_FRESHNESS });
    source.download.mockResolvedValue(new ArrayBuffer(0));
    source.parse.mockResolvedValue({ fetchedAt: SOURCE_FRESHNESS, totalOrders: 0, orders: [] });
    vi.spyOn(projectionEngine, "refresh").mockResolvedValue(undefined);
    const syncRuns = await failedParentRun(["CREATED"]);
    const population = new PopulationRepository();
    population.manifest = {
      ...completeManifest(),
      population_status: "FAILED",
      persisted_observation_count: 12,
    };
    population.persistedCount = 12;
    const service = new SyncService(syncRuns, null, incidentRepository(), null, null, null, null, null, null, null, null, null, population);

    const result = await service.runSync();

    expect(result.ok).toBe(true);
    expect(source.fetch).toHaveBeenCalledTimes(1);
    expect(source.download).toHaveBeenCalledTimes(1);
    expect(source.parse).toHaveBeenCalledTimes(1);
    expect(population.replacements).toBe(1);
    expect(population.deletes).toBe(1);
    expect(population.completions).toBe(1);
    expect(population.manifest?.population_status).toBe("COMPLETE");
  });

  it("fails closed when a COMPLETE population is not accompanied by rehydratable completed downstream state", async () => {
    vi.stubEnv("SNAPSHOT_V3_SHADOW_ENABLED", "false");
    const source = sourceConnectorSpies();
    const syncRuns = await failedParentRun(["CREATED", "FETCHING_SNAPSHOT"]);
    const population = new PopulationRepository();
    const service = new SyncService(syncRuns, null, new MockIncidentRepository(), null, null, null, null, null, null, null, null, null, population);

    const result = await service.runSync();

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("INBOUND_COMPLETE_POPULATION_RESUME_STATE_UNAVAILABLE");
    expect(source.fetch).not.toHaveBeenCalled();
    expect(source.download).not.toHaveBeenCalled();
    expect(source.parse).not.toHaveBeenCalled();
    expect(population.replacements).toBe(0);
    expect(population.deletes).toBe(0);
    expect(population.inserts).toBe(0);
    expect(population.manifest?.population_status).toBe("COMPLETE");
  });
});
