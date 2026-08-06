import { SyncService } from "../src/services/impl/SyncService";
import { MockSyncRunRepository } from "../src/repositories/mock/MockSyncRunRepository";

async function main() {
  console.log("=== STARTING CROSS-PROCESS SIMULATION ===");
  const repo = new MockSyncRunRepository();
  const runRow = await repo.createSyncRun();
  
  // Simulate crash after PERSISTING_SNAPSHOTS:
  await repo.updatePhase(runRow.id, "PERSISTING_SNAPSHOTS", ["CREATED", "FETCHING_SNAPSHOT", "PERSISTING_SNAPSHOTS"]);

  console.log("=== PROCESS RESTART SIMULATION: NEW INSTANCE OF SYNCSERVICE ===");
  const newService = new SyncService(repo);
  const result = await newService.runSync();

  console.log("=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
