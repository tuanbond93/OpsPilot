import { describe, expect, it } from "vitest";
import { assessOperationalCohort, type OperationalCohort } from "@/domain/operational-learning/checkpoint-policy";
import {
  hydrateOperationalCohortV2,
  operationalCohortMemberRows,
  operationalCohortV2Metadata,
  type FollowupCaseMemberRow,
} from "@/domain/operational-learning/normalized-followup-members";
import {
  assertRollbackCohortParity,
  restoreLegacyOnlyMemberFields,
} from "@/services/followup-cohort-rollback";

const CASE_ID = "11111111-1111-4111-8111-111111111111";

function v1Fixture(): OperationalCohort {
  return {
    version: 1,
    day: "2026-09-24",
    capturedAt: "2026-09-24T01:00:00.000Z",
    baselineCodes: ["ORDER-A", "ORDER-B"],
    lastCheckpoint: "2026-09-24:8",
    verification: {
      source: "ghn_internal_order_logs",
      checkedAt: "2026-09-24T01:00:00.000Z",
      failures: { "ORDER-B": "NO_MATCHING_LOG" },
    },
    members: ["ORDER-A", "ORDER-B"].map((orderCode, index) => ({
      orderCode,
      customerId: "CUSTOMER-A",
      warehouseId: "WH-A",
      stage: "DELIVERY" as const,
      status: "storing",
      observedAt: "2026-09-24T01:00:00.000Z",
      readyAt: "2026-09-23T12:00:00.000Z",
      source: "rillnet" as const,
      eventAt: `2026-09-24T00:0${index}:00.000Z`,
      observedWarehouseId: "WH-A",
      firstSeenAt: "2026-09-23T08:00:00.000Z",
      baselineStatus: "storing",
      dueAt: "2026-09-24T03:00:00.000Z",
      lastReminderAt: "2026-09-24T01:00:00.000Z",
      lastReminderStatus: "storing",
    })),
  };
}

function sameDomainCohort(a: OperationalCohort, b: OperationalCohort): void {
  assertRollbackCohortParity(a, b);
  expect(b.day).toBe(a.day);
  expect(b.capturedAt).toBe(a.capturedAt);
  expect(b.lastCheckpoint).toBe(a.lastCheckpoint);
  expect(b.members.map((member) => ({
    orderCode: member.orderCode,
    customerId: member.customerId,
    warehouseId: member.warehouseId,
    stage: member.stage,
    status: member.status,
    observedAt: member.observedAt,
    readyAt: member.readyAt,
    dueAt: member.dueAt,
    baselineStatus: member.baselineStatus,
    lastReminderAt: member.lastReminderAt,
    lastReminderStatus: member.lastReminderStatus,
    completedAt: member.completedAt,
  }))).toEqual(a.members.map((member) => ({
    orderCode: member.orderCode,
    customerId: member.customerId,
    warehouseId: member.warehouseId,
    stage: member.stage,
    status: member.status,
    observedAt: member.observedAt,
    readyAt: member.readyAt,
    dueAt: member.dueAt,
    baselineStatus: member.baselineStatus,
    lastReminderAt: member.lastReminderAt,
    lastReminderStatus: member.lastReminderStatus,
    completedAt: member.completedAt,
  })));
}

describe("follow-up generation retention and rollback materialization", () => {
  it("backfills, runs three generations, retains current+previous, then materializes equivalent V1 state", () => {
    const archive = v1Fixture();
    let current = structuredClone(archive);
    const generations = new Map<string, { metadata: ReturnType<typeof operationalCohortV2Metadata>; rows: FollowupCaseMemberRow[] }>();
    const commitOrder: string[] = [];

    const saveGeneration = (id: string, cohort: OperationalCohort) => {
      const metadata = operationalCohortV2Metadata(cohort);
      const rows = operationalCohortMemberRows(CASE_ID, id, null, cohort);
      const restored = hydrateOperationalCohortV2(metadata, rows, { followupCaseId: CASE_ID, generationId: id });
      sameDomainCohort(cohort, restored);
      generations.set(id, { metadata, rows });
      commitOrder.push(id);
      current = restored;
    };

    saveGeneration("backfill-generation", current);
    for (let checkpoint = 1; checkpoint <= 3; checkpoint++) {
      const next = structuredClone(current);
      next.lastCheckpoint = `2026-09-24:${10 + checkpoint * 2}`;
      next.members[0].status = checkpoint === 3 ? "delivered" : "delivering";
      next.members[0].lastReminderAt = `2026-09-24T0${checkpoint + 2}:00:00.000Z`;
      next.members[0].lastReminderStatus = next.members[0].status;
      if (checkpoint === 3) {
        next.members[1].lastReminderAt = undefined;
        next.members[1].lastReminderStatus = undefined;
      }
      if (checkpoint === 3) next.members[0].completedAt = "2026-09-24T07:00:00.000Z";
      next.verification = {
        source: "ghn_internal_order_logs",
        checkedAt: `2026-09-24T0${checkpoint + 2}:00:00.000Z`,
        failures: checkpoint === 2 ? { "ORDER-B": "NO_MATCHING_LOG" } : {},
      };
      saveGeneration(`checkpoint-${checkpoint}`, next);
    }

    const currentGenerationId = commitOrder.at(-1)!;
    const previousGenerationId = commitOrder.at(-2)!;
    for (const generationId of [...generations.keys()]) {
      if (generationId !== currentGenerationId && generationId !== previousGenerationId) generations.delete(generationId);
    }
    expect([...generations.keys()]).toEqual([previousGenerationId, currentGenerationId]);

    const pointed = generations.get(currentGenerationId)!;
    const v2Cohort = hydrateOperationalCohortV2(pointed.metadata, pointed.rows, {
      followupCaseId: CASE_ID,
      generationId: currentGenerationId,
    });
    const rolledBack = restoreLegacyOnlyMemberFields(v2Cohort, archive);
    sameDomainCohort(v2Cohort, rolledBack);
    expect(rolledBack.members[0]).toMatchObject({
      firstSeenAt: "2026-09-23T08:00:00.000Z",
      eventAt: "2026-09-24T00:00:00.000Z",
      observedWarehouseId: "WH-A",
    });

    const now = Date.parse("2026-09-24T07:00:00.000Z");
    const observations = new Map(v2Cohort.members.map((member) => [member.orderCode, {
      orderCode: member.orderCode,
      customerId: member.customerId,
      warehouseId: member.warehouseId,
      stage: member.stage,
      status: member.status,
      observedAt: new Date(now).toISOString(),
      readyAt: member.readyAt,
      source: member.source,
    }]));
    const v2Assessment = assessOperationalCohort(v2Cohort, [], observations, now);
    const rollbackAssessment = assessOperationalCohort(rolledBack, [], observations, now);
    expect({
      due: rollbackAssessment.due,
      completed: rollbackAssessment.completed,
      progressed: rollbackAssessment.progressed,
      pending: rollbackAssessment.pending,
      reminderCodes: rollbackAssessment.reminderCodes,
      progressPercent: rollbackAssessment.progressPercent,
      baselineDue: rollbackAssessment.baselineDue,
      baselineProgressed: rollbackAssessment.baselineProgressed,
      baselinePending: rollbackAssessment.baselinePending,
      assessment: rollbackAssessment.assessment,
    }).toEqual({
      due: v2Assessment.due,
      completed: v2Assessment.completed,
      progressed: v2Assessment.progressed,
      pending: v2Assessment.pending,
      reminderCodes: v2Assessment.reminderCodes,
      progressPercent: v2Assessment.progressPercent,
      baselineDue: v2Assessment.baselineDue,
      baselineProgressed: v2Assessment.baselineProgressed,
      baselinePending: v2Assessment.baselinePending,
      assessment: v2Assessment.assessment,
    });
    // Telegram's follow-up order-code payload derives from the same assessment.
    expect(rollbackAssessment.reminderCodes).toEqual(v2Assessment.reminderCodes);
    expect(rollbackAssessment.reminderCodes).toEqual(["ORDER-B"]);
  });
});
