import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  IInboundOrderObservationRepository,
  InboundOrderObservationRow,
  InboundPopulationManifest,
  InboundPopulationManifestInput,
} from "@/repositories/interfaces/IInboundOrderObservationRepository";
import type { TriageAuditInsert, TriageAuditRecord } from "@/repositories/interfaces/ITriageAuditRepository";
import type { SyncPhase } from "@/connectors/supabase/types";
import { SyncService } from "@/services/impl/SyncService";
import { MockAiJobRepository } from "@/repositories/mock/MockAiJobRepository";
import { MockIncidentRepository } from "@/repositories/mock/MockIncidentRepository";
import { MockSyncRunRepository } from "@/repositories/mock/MockSyncRunRepository";
import { FollowupEngine } from "@/engine/followup";
import * as projectionEngine from "@/projections/projection-engine";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const CHECKPOINT_AT = "2026-09-23T11:00:00.000Z";
const INCIDENT_ID = "22222222-2222-4222-8222-222222222222";
const COMPLETED_PHASES: SyncPhase[] = [
  "CREATED",
  "FETCHING_SNAPSHOT",
  "PERSISTING_SNAPSHOTS",
  "PERSISTING_INCIDENTS",
  "PERSISTING_HISTORY",
  "PROCESSING_FOLLOWUPS",
  "ENQUEUE_NOTIFICATIONS",
];

class CompletePopulationRepository implements IInboundOrderObservationRepository {
  manifest: InboundPopulationManifest = {
    sync_run_id: RUN_ID,
    source_system: "RILLNET",
    population_status: "COMPLETE",
    normalized_population_count: 1,
    expected_observation_count: 1,
    persisted_observation_count: 1,
    duplicate_identical_count: 0,
    duplicate_conflict_count: 0,
    source_freshness: CHECKPOINT_AT,
    population_completed_at: CHECKPOINT_AT,
  };
  replacements = 0;
  inserts = 0;

  async getPopulationManifest(): Promise<InboundPopulationManifest> { return this.manifest; }
  async replaceIncompletePopulation(_input: InboundPopulationManifestInput): Promise<void> { this.replacements++; }
  async insertBatch(rows: InboundOrderObservationRow[]): Promise<number> { this.inserts += rows.length; return rows.length; }
  async countPersisted(): Promise<number> { return 1; }
  async completePopulation(): Promise<void> { throw new Error("COMPLETE_POPULATION_MUST_NOT_BE_REWRITTEN"); }
  async failPopulation(): Promise<void> { throw new Error("COMPLETE_POPULATION_MUST_NOT_BE_FAILED"); }
}

class TriageAuditRepository {
  records: TriageAuditInsert[] = [];
  async recordBatch(items: TriageAuditInsert[]): Promise<number> { this.records = items; return items.length; }
  async getLatestByIncidentIds(_ids: string[]): Promise<TriageAuditRecord[]> { return []; }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("same-checkpoint AI enqueue resume", () => {
  it("resumes the incomplete run and invokes the run-scoped enqueue once", async () => {
    vi.stubEnv("SNAPSHOT_V3_SHADOW_ENABLED", "false");
    vi.spyOn(projectionEngine, "refresh").mockResolvedValue(undefined);
    const syncRuns = new MockSyncRunRepository();
    await syncRuns.createSyncRun(CHECKPOINT_AT, { id: RUN_ID, checkpointAt: CHECKPOINT_AT });
    await syncRuns.updatePhase(RUN_ID, "ENQUEUE_NOTIFICATIONS", COMPLETED_PHASES);
    await syncRuns.updateFailed(RUN_ID, {
      completedAt: CHECKPOINT_AT,
      durationMs: 300_000,
      errorCode: "SimulatedInterruption",
      errorMessage: "Stopped before ENQUEUE_AI phase completion",
    });

    const incidents = new MockIncidentRepository();
    incidents.seed([{
      id: INCIDENT_ID,
      incident_key: "21600000:THIEU_SHIPPER",
      warehouse_id: "21600000",
      warehouse_name: "Warehouse",
      reason_code: "THIEU_SHIPPER",
      reason_name: "Thiếu shipper",
      status: "open",
      priority_score: 80,
      first_detected_at: CHECKPOINT_AT,
      last_detected_at: CHECKPOINT_AT,
      last_sync_run_id: RUN_ID,
    }]);

    const aiJobs = new MockAiJobRepository();
    aiJobs.seedEligibleForSyncRun(RUN_ID, [{ incidentId: INCIDENT_ID, priority: "urgent" }]);
    const audit = new TriageAuditRepository();
    const population = new CompletePopulationRepository();
    const followup = vi.spyOn(FollowupEngine.prototype, "processIncidentFollowups").mockResolvedValue([]);
    const service = new SyncService(
      syncRuns,
      null,
      incidents,
      null,
      null,
      null,
      aiJobs,
      null,
      null,
      audit,
      null,
      null,
      population,
    );

    const result = await service.runSync({ checkpointAt: CHECKPOINT_AT });

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.syncRunId).toBe(RUN_ID);
    expect(aiJobs.enqueueRunCallCount).toBe(1);
    expect(await aiJobs.getAllJobs()).toHaveLength(1);
    expect(followup).not.toHaveBeenCalled();
    expect(population.replacements).toBe(0);
    expect(population.inserts).toBe(0);
    expect((await syncRuns.getLatestSyncRun())?.status).toBe("success");
  });
});
