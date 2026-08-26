import { SyncService } from "../src/services/impl/SyncService";
import { MockSyncRunRepository } from "../src/repositories/mock/MockSyncRunRepository";
import { MockIncidentRepository } from "../src/repositories/mock/MockIncidentRepository";
import type { SyncPhase } from "../src/connectors/supabase/types";
import { installRillnetFetchFixture } from "../src/__tests__/fixtures/rillnet-fetch";

installRillnetFetchFixture();

async function main() {
  const arg = process.argv.find((a) => a.startsWith("--phase="));
  const lastCompletedPhase = arg ? (arg.split("=")[1] as SyncPhase) : "FETCHING_SNAPSHOT";

  const syncRunRepo = new MockSyncRunRepository();
  const incidentRepo = new MockIncidentRepository();

  const runRow = await syncRunRepo.createSyncRun();

  if (
    [
      "PERSISTING_INCIDENTS",
      "PERSISTING_HISTORY",
      "PROCESSING_FOLLOWUPS",
      "ENQUEUE_NOTIFICATIONS",
      "ENQUEUE_AI",
      "REFRESHING_PROJECTIONS",
    ].includes(lastCompletedPhase)
  ) {
    await incidentRepo.upsertIncidents(
      [
        {
          incidentId: "inc-test-1",
          incidentKey: "21160000:KHO_TON",
          warehouseId: "21160000",
          warehouseName: "Kho Phú Thọ",
          reasonCode: "KHO_TON",
          reasonName: "Kho tồn",
          status: "open",
          priorityScore: 80,
          firstDetectedAt: "2026-08-05T08:00:00Z",
          lastDetectedAt: "2026-08-05T08:00:00Z",
          affectedOrderCount: 10,
          sampleOrderCodes: [],
          averageAgeHours: 24,
          maximumAgeHours: 48,
          oldestOrderCode: "ORD-100",
        },
      ],
      runRow.id
    );
  }

  const phases: SyncPhase[] = [
    "CREATED",
    "FETCHING_SNAPSHOT",
    "PERSISTING_SNAPSHOTS",
    "PERSISTING_INCIDENTS",
    "PERSISTING_HISTORY",
    "PROCESSING_FOLLOWUPS",
    "ENQUEUE_NOTIFICATIONS",
    "ENQUEUE_AI",
    "REFRESHING_PROJECTIONS",
  ];
  const cutoffIdx = phases.indexOf(lastCompletedPhase);
  const completedBefore = phases.slice(0, cutoffIdx + 1);

  await syncRunRepo.updatePhase(runRow.id, lastCompletedPhase, completedBefore);

  // PROCESS RESTART: Create new SyncService instance in a separate Node process
  const service = new SyncService(syncRunRepo, null, incidentRepo);
  const result = await service.runSync();
  console.log("RESULT_JSON:" + JSON.stringify({ ok: result.ok, incidentCount: result.incidentCount, syncRunId: result.syncRunId }));
}

main().catch(console.error);
