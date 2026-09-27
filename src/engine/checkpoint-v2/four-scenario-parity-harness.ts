/**
 * Deterministic V1/V2 Phase 6 parity fixtures.
 *
 * This module deliberately has no environment lookup and no client factory.
 * A caller must explicitly provide a staging Supabase client before the V2
 * setup or candidate execution functions can perform any IO.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet/types";
import type { FollowupCaseRow, FollowupState, OrderSnapshotRow } from "@/connectors/supabase/types";
import type { Incident, IncidentReasonCode } from "@/engine/incident";
import { FollowupEngine, type ProcessedFollowupItem } from "@/engine/followup/followup-engine";
import { DEFAULT_FOLLOWUP_CONFIG } from "@/config/followup";
import { CheckpointOrchestrator } from "./checkpoint-orchestrator";
import { CheckpointWorker } from "./checkpoint-worker";
import { PostBarrierShadowHandler } from "./post-barrier-handler";
import { SupabaseDispatchLedgerStorage } from "./dispatch-ledger";
import { MockCheckpointWorkQueueRepository } from "@/repositories/mock/MockCheckpointWorkQueueRepository";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";
import { MockIncidentHistoryRepository } from "@/repositories/mock/MockIncidentHistoryRepository";
import { MockIncidentRepository } from "@/repositories/mock/MockIncidentRepository";
import { MockOrderSnapshotRepository } from "@/repositories/mock/MockOrderSnapshotRepository";
import { MockSyncRunRepository } from "@/repositories/mock/MockSyncRunRepository";
import { SupabaseCheckpointWorkQueueRepository } from "@/repositories/supabase/SupabaseCheckpointWorkQueueRepository";
import { SupabaseFollowupRepository } from "@/repositories/supabase/SupabaseFollowupRepository";
import { SupabaseIncidentHistoryRepository } from "@/repositories/supabase/SupabaseIncidentHistoryRepository";
import { SupabaseIncidentRepository } from "@/repositories/supabase/SupabaseIncidentRepository";
import { SupabaseOrderSnapshotRepository } from "@/repositories/supabase/SupabaseOrderSnapshotRepository";
import { SupabaseSyncRunRepository } from "@/repositories/supabase/SupabaseSyncRunRepository";

export const SCENARIO_FIXTURES_CREATED = 4 as const;

export type CanonicalParityScenario =
  | "NEW_FIRST_PUSH"
  | "UNCHANGED_WAITING"
  | "BACKLOG_CHANGED"
  | "RESOLVED_COMPLETED";

export interface ParityComparisonStructure {
  case: { incidentKey: string; expectedCaseId: string };
  decision: { oldState: FollowupState; expectedNewState?: FollowupState };
  members: { expectedOrderCodes: string[] };
  generation: { id: string };
  intervention: { expectedActionType: string | null };
}

export interface FourScenarioParityFixture {
  scenario: CanonicalParityScenario;
  checkpointAt: string;
  syncRunId: string;
  caseId: string;
  incident: Incident;
  orders: NormalizedRillnetOrder[];
  priorCase?: FollowupCaseRow;
  comparison: ParityComparisonStructure;
}

const scenarioRows: Array<{
  scenario: CanonicalParityScenario;
  ordinal: number;
  checkpointAnchor: string;
  oldState: FollowupState;
  status: string;
  prior: boolean;
  orderCount: number;
}> = [
  { scenario: "NEW_FIRST_PUSH", ordinal: 1, checkpointAnchor: "2026-10-01T07:00:00.000Z", oldState: "NEW", status: "storing", prior: false, orderCount: 1 },
  { scenario: "UNCHANGED_WAITING", ordinal: 2, checkpointAnchor: "2026-10-02T07:00:00.000Z", oldState: "FOLLOWING_UP", status: "storing", prior: true, orderCount: 1 },
  { scenario: "BACKLOG_CHANGED", ordinal: 3, checkpointAnchor: "2026-10-03T07:00:00.000Z", oldState: "FIRST_PUSH_SENT", status: "storing", prior: true, orderCount: 2 },
  { scenario: "RESOLVED_COMPLETED", ordinal: 4, checkpointAnchor: "2026-10-04T07:00:00.000Z", oldState: "FIRST_PUSH_SENT", status: "delivered", prior: true, orderCount: 1 },
];

const slug = (scenario: CanonicalParityScenario) => scenario.toLowerCase();

/** Derive durable UUIDs deterministically from an explicit execution namespace. */
function namespacedUuid(namespace: string, label: string): string {
  const hex = createHash("sha256").update(`${namespace}:${label}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const isoOffset = (checkpointAt: string, offsetMs: number) => new Date(Date.parse(checkpointAt) + offsetMs).toISOString();
const governedCheckpointAnchor = (checkpointAt: string) => {
  const checkpoint = new Date(checkpointAt);
  return Date.UTC(checkpoint.getUTCFullYear(), checkpoint.getUTCMonth(), checkpoint.getUTCDate(), 7, 0, 0, 0);
};

function orderFor(scenario: CanonicalParityScenario, index: number, status: string, checkpointAt: string): NormalizedRillnetOrder {
  const key = slug(scenario);
  // TRANSIT orders arriving before 07:00 are due at the 14:00 checkpoint.
  // The waiting scenario arrives after 07:00, deterministically putting it
  // into the next operating-window deadline.
  const arrival = scenario === "UNCHANGED_WAITING"
    ? new Date(governedCheckpointAnchor(checkpointAt) - 6.5 * 3_600_000).toISOString()
    : new Date(governedCheckpointAnchor(checkpointAt) - 7.5 * 3_600_000).toISOString();
  return {
    id: `order-${key}-${index}`,
    orderCode: `PARITY_${scenario}_${index}`,
    status,
    taskCategory: "chuyen_tiep",
    warehouseId: "WH_PARITY_01",
    warehouseName: "Kho Hub Parity",
    customerId: `customer-${key}-${index}`,
    customerName: `Parity customer ${index}`,
    customerCode: `PARITY-${index}`,
    createdAt: isoOffset(checkpointAt, -21 * 3_600_000),
    deliverWarehouseId: "WH_PARITY_02",
    warehouseLog: [{ current_warehouse_id: "WH_PARITY_01", updated_date: arrival }],
    endPickAt: isoOffset(checkpointAt, -9 * 3_600_000),
    fetchedAt: isoOffset(checkpointAt, -5 * 60_000),
  };
}

function priorCaseFor(
  scenario: CanonicalParityScenario,
  incident: Incident,
  orders: NormalizedRillnetOrder[],
  oldState: FollowupState,
  caseId: string,
  checkpointAt: string,
): FollowupCaseRow {
  return {
    id: caseId,
    incident_id: incident.incidentId,
    incident_key: incident.incidentKey,
    current_state: oldState,
    first_detected_at: isoOffset(checkpointAt, -27 * 3_600_000),
    last_checked_at: isoOffset(checkpointAt, -24 * 3_600_000),
    last_action_requested_at: isoOffset(checkpointAt, -24 * 3_600_000),
    baseline_affected_order_count: 1,
    latest_affected_order_count: 1,
    current_progress_percent: 0,
    current_assessment: "no_progress",
    operational_cohort: {
      version: 1,
      day: new Date(Date.parse(checkpointAt) + 7 * 3_600_000).toISOString().slice(0, 10),
      capturedAt: isoOffset(checkpointAt, -6 * 3_600_000),
      baselineCodes: orders.map(order => order.orderCode),
      members: orders.map(order => ({
        orderCode: order.orderCode,
        customerId: order.customerId,
        warehouseId: order.warehouseId,
        stage: "TRANSIT",
        status: oldState === "FIRST_PUSH_SENT" && scenario === "RESOLVED_COMPLETED" ? "storing" : order.status,
        observedAt: isoOffset(checkpointAt, -6 * 3_600_000),
        readyAt: new Date(governedCheckpointAnchor(checkpointAt) - 7.5 * 3_600_000).toISOString(),
        dueAt: new Date(governedCheckpointAnchor(checkpointAt) - 7 * 3_600_000).toISOString(),
        baselineStatus: "storing",
        firstSeenAt: isoOffset(checkpointAt, -6 * 3_600_000),
        lastReminderAt: isoOffset(checkpointAt, -24 * 3_600_000),
        lastReminderStatus: "storing",
      })),
    },
  };
}

/** Creates exactly the four canonical, deterministic inputs. */
export function createFourScenarioParityFixtures(identifierNamespace: string = "checkpoint-v2-parity-fixture-v1"): FourScenarioParityFixture[] {
  const checkpointOffsetMs = Number.parseInt(createHash("sha256").update(identifierNamespace).digest("hex").slice(0, 8), 16) % 3_600_000;
  return scenarioRows.map(({ scenario, ordinal, checkpointAnchor, oldState, status, prior, orderCount }) => {
    // Keep every fixture at the governed 14:00 ICT checkpoint hour while
    // making its full timestamp unique to this execution namespace.
    const checkpointAt = isoOffset(checkpointAnchor, checkpointOffsetMs);
    const orders = Array.from({ length: orderCount }, (_, index) => orderFor(scenario, index + 1, status, checkpointAt));
    const incidentKey = `WH_PARITY_01:${scenario}`;
    const incident: Incident = {
      incidentId: namespacedUuid(identifierNamespace, `incident:${ordinal}`),
      incidentKey,
      warehouseId: "WH_PARITY_01",
      warehouseName: "Kho Hub Parity",
      reasonCode: "TRANSIT_DELAY" as IncidentReasonCode,
      reasonName: "Deterministic parity scenario",
      status: "open",
      priorityScore: 50,
      affectedOrders: orders.map(order => order.orderCode),
      affectedOrderCount: scenario === "RESOLVED_COMPLETED" ? 1 : orders.length,
      sampleOrderCodes: orders.map(order => order.orderCode),
      averageAgeHours: null,
      maximumAgeHours: null,
      oldestOrderCode: null,
      firstDetectedAt: isoOffset(checkpointAt, -27 * 3_600_000),
      lastDetectedAt: checkpointAt,
    };
    const caseId = namespacedUuid(identifierNamespace, `case:${ordinal}`);
    const syncRunId = namespacedUuid(identifierNamespace, `run:${ordinal}`);
    const expectedNewState: FollowupState = scenario === "NEW_FIRST_PUSH"
      ? "FIRST_PUSH_PENDING"
      : scenario === "UNCHANGED_WAITING"
      ? "FOLLOWING_UP"
      : scenario === "BACKLOG_CHANGED"
      ? "SECOND_PUSH_PENDING"
      : "RESOLVED";
    const expectedActionType = scenario === "NEW_FIRST_PUSH"
      ? "FIRST_PUSH"
      : scenario === "BACKLOG_CHANGED"
      ? "SECOND_PUSH"
      : null;
    return {
      scenario,
      checkpointAt,
      syncRunId,
      caseId,
      incident,
      orders,
      priorCase: prior ? priorCaseFor(scenario, incident, orders, oldState, caseId, checkpointAt) : undefined,
      comparison: {
        case: { incidentKey, expectedCaseId: caseId },
        decision: { oldState, expectedNewState },
        members: { expectedOrderCodes: orders.map(order => order.orderCode) },
        generation: { id: syncRunId },
        intervention: { expectedActionType },
      },
    };
  });
}

export interface IsolatedV1ReferenceResult {
  fixture: FourScenarioParityFixture;
  decisions: ProcessedFollowupItem[];
  cases: FollowupCaseRow[];
}

/** Runs governed V1 Phase 6 with repository instances unique to one fixture. */
export async function executeIsolatedV1Reference(
  fixture: FourScenarioParityFixture,
): Promise<IsolatedV1ReferenceResult> {
  const snapshotRepo = new MockOrderSnapshotRepository();
  const syncRunRepo = new MockSyncRunRepository();
  const incidentRepo = new MockIncidentRepository();
  const historyRepo = new MockIncidentHistoryRepository();
  const followupRepo = new MockFollowupRepository();
  await syncRunRepo.createSyncRun(fixture.checkpointAt, { id: fixture.syncRunId, checkpointAt: fixture.checkpointAt });
  await snapshotRepo.insertBatch(toSnapshotRows(fixture));
  const persistedIncidents = await incidentRepo.upsertIncidents([fixture.incident], fixture.syncRunId);
  await historyRepo.insertHistoryRecords(
    new Map([[fixture.incident.incidentKey, persistedIncidents[0].id]]),
    [fixture.incident], fixture.syncRunId, fixture.checkpointAt,
  );
  if (fixture.priorCase) await followupRepo.upsertCase(fixture.priorCase);
  const history = await historyRepo.getHistoriesByIncidentIds([persistedIncidents[0].id]);
  const decisions = await new FollowupEngine(followupRepo).processIncidentFollowups(
    [{ ...fixture.incident, incidentId: persistedIncidents[0].id }],
    history,
    DEFAULT_FOLLOWUP_CONFIG,
    Date.parse(fixture.checkpointAt),
    fixture.orders,
    fixture.syncRunId,
  );
  return { fixture, decisions, cases: await followupRepo.getAllCases() };
}

function toSnapshotRows(fixture: FourScenarioParityFixture): OrderSnapshotRow[] {
  return fixture.orders.map(order => ({
    sync_run_id: fixture.syncRunId,
    order_code: order.orderCode,
    warehouse_id: order.warehouseId,
    warehouse_name: order.warehouseName,
    source_status: order.status,
    task_category: order.taskCategory,
    source_updated_at: order.fetchedAt,
    order_created_at: order.createdAt,
    deliver_warehouse_id: order.deliverWarehouseId,
    end_pick_at: order.endPickAt,
    warehouse_log: order.warehouseLog,
  }));
}

/**
 * Explicit V2 staging adapter. Constructing it has no side effects; callers
 * must call setupInput / executeCandidate in a separately authorized session.
 */
export function createV2StagingParityAdapter(client: SupabaseClient) {
  const orderSnapshotRepo = new SupabaseOrderSnapshotRepository(client);
  const syncRunRepo = new SupabaseSyncRunRepository(client);
  const incidentRepo = new SupabaseIncidentRepository(client);
  const incidentHistoryRepo = new SupabaseIncidentHistoryRepository(client);
  const followupRepo = new SupabaseFollowupRepository(client);
  const queueRepo = new SupabaseCheckpointWorkQueueRepository(client);

  return {
    async setupInput(fixture: FourScenarioParityFixture): Promise<void> {
      await syncRunRepo.createSyncRun(fixture.checkpointAt, { id: fixture.syncRunId, checkpointAt: fixture.checkpointAt });
      await orderSnapshotRepo.insertBatch(toSnapshotRows(fixture));
      const persisted = await incidentRepo.upsertIncidents([fixture.incident], fixture.syncRunId);
      const incident = { ...fixture.incident, incidentId: persisted[0].id };
      await incidentHistoryRepo.insertHistoryRecords(new Map([[incident.incidentKey, incident.incidentId]]), [incident], fixture.syncRunId, fixture.checkpointAt);
      if (fixture.priorCase) await followupRepo.upsertCase({ ...fixture.priorCase, incident_id: incident.incidentId });
      await new CheckpointOrchestrator(queueRepo).initializePostBarrierCheckpoint({
        checkpointAt: fixture.checkpointAt, syncRunId: fixture.syncRunId, caseCount: 1, estimatedMembers: fixture.orders.length, executionMode: "SHADOW",
      });
    },
    async executeCandidate(fixture: FourScenarioParityFixture) {
      const handler = new PostBarrierShadowHandler({
        orderSnapshotRepo, syncRunRepo, incidentRepo, incidentHistoryRepo, followupRepo,
        dispatchLedgerStorage: new SupabaseDispatchLedgerStorage(client),
      });
      await new CheckpointWorker(queueRepo, undefined, `v2-parity-${slug(fixture.scenario)}`).runLoop(
        fixture.checkpointAt, fixture.syncRunId, handler.createExecutionHandler(), "SHADOW",
      );
      return handler.getExecutionState(fixture.checkpointAt, fixture.syncRunId);
    },
  };
}

// Kept exported for later candidate-side tests; this session never invokes it.
export const createLocalV2ParityQueue = () => new MockCheckpointWorkQueueRepository();
