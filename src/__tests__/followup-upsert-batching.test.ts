import { describe, expect, it } from "vitest";
import type { FollowupCaseUpsert } from "@/repositories/interfaces/IFollowupRepository";
import {
  FOLLOWUP_CASE_UPSERT_MAX_PAYLOAD_BYTES,
  FOLLOWUP_CASE_UPSERT_MAX_ROWS,
  followupCaseUpsertPayloadBytes,
  planFollowupCaseUpsertChunks,
} from "@/engine/followup/upsert-batching";

function productionShapedMutation(index: number): FollowupCaseUpsert {
  const members = Array.from({ length: 60 }, (_, memberIndex) => {
    const orderCode = `ORDER-${String(index).padStart(4, "0")}-${String(memberIndex).padStart(3, "0")}`;
    return {
      orderCode,
      customerId: `CUSTOMER-${String(index).padStart(4, "0")}`,
      warehouseId: `WAREHOUSE-${String(index).padStart(4, "0")}`,
      stage: "TRANSIT" as const,
      status: "storing",
      observedAt: "2026-09-24T01:00:00.000Z",
      readyAt: "2026-09-24T00:00:00.000Z",
      source: "rillnet" as const,
      firstSeenAt: "2026-09-24T01:00:00.000Z",
      dueAt: "2026-09-24T00:00:00.000Z",
      baselineStatus: "storing",
    };
  });
  const orderCodes = members.map(member => member.orderCode);

  return {
    incident_id: `incident-${index}`,
    incident_key: `warehouse-${index}:KHO_TON`,
    current_state: "FOLLOWING_UP",
    operational_cohort: {
      version: 1,
      day: "2026-09-24",
      capturedAt: "2026-09-24T01:00:00.000Z",
      baselineCodes: orderCodes,
      members,
      lastCheckpoint: "2026-09-24:8",
    },
    ...(index % 2 === 0 ? { created_at: "2026-09-23T11:00:00.000Z" } : {}),
  } as FollowupCaseUpsert;
}

describe("follow-up upsert chunk planning", () => {
  it("bounds 1,063 production-shaped mutations by rows and serialized JSON bytes without dropping or duplicating cases", () => {
    const mutations = Array.from({ length: 1063 }, (_, index) => productionShapedMutation(index));
    const totalPayloadBytes = followupCaseUpsertPayloadBytes(mutations);
    const chunks = planFollowupCaseUpsertChunks(mutations);
    const persistedOrder = chunks.flat().map(item => item.incident_key);

    expect(totalPayloadBytes).toBeGreaterThan(19_158_425);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every(chunk => chunk.length <= FOLLOWUP_CASE_UPSERT_MAX_ROWS)).toBe(true);
    expect(chunks.every(chunk => followupCaseUpsertPayloadBytes(chunk) <= FOLLOWUP_CASE_UPSERT_MAX_PAYLOAD_BYTES)).toBe(true);
    expect(persistedOrder).toEqual(mutations.map(item => item.incident_key));
    expect(new Set(persistedOrder).size).toBe(1063);
  });

  it("returns no chunks for zero mutations", () => {
    expect(planFollowupCaseUpsertChunks([])).toEqual([]);
  });

  it("rejects a single indivisible row above the configured payload bound", () => {
    const oversized = productionShapedMutation(1);
    oversized.operational_cohort = {
      ...oversized.operational_cohort!,
      members: Array.from({ length: 1200 }, (_, index) => ({
        orderCode: `OVERSIZED-${index}`,
        customerId: "customer",
        warehouseId: "warehouse",
        stage: "TRANSIT" as const,
        status: "storing",
        observedAt: "2026-09-24T01:00:00.000Z",
        readyAt: "2026-09-24T00:00:00.000Z",
        firstSeenAt: "2026-09-24T01:00:00.000Z",
        dueAt: "2026-09-24T00:00:00.000Z",
        baselineStatus: "storing",
      })),
    };

    expect(() => planFollowupCaseUpsertChunks([oversized])).toThrow("FOLLOWUP_CASE_UPSERT_ROW_EXCEEDS_MAX_PAYLOAD_BYTES");
  });
});
