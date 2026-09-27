import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  selectActiveWorkingSet,
  isTerminalOrderStatus,
  isActiveWorkingSetFeatureEnabled,
  DEFAULT_RECONCILIATION_WINDOW_MS,
} from "@/domain/load-shedding/active-working-set";
import {
  computeMaterialFingerprint,
  evaluateCaseHeavyProcessingSkip,
  isSkipUnchangedNotDueFeatureEnabled,
} from "@/domain/load-shedding/case-fingerprint";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet/types";

describe("Release A — Load Shedding Domain Logic", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ACTIVE_WORKING_SET_V0;
    delete process.env.SKIP_UNCHANGED_NOT_DUE_V0;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function createMockOrder(overrides: Partial<NormalizedRillnetOrder>): NormalizedRillnetOrder {
    return {
      id: "test-id",
      orderCode: "TEST_ORDER",
      status: "storing",
      taskCategory: "INBOUND",
      warehouseId: "WH-1",
      warehouseName: "Warehouse 1",
      customerId: "C-1",
      customerName: "Customer 1",
      customerCode: "CUST-1",
      createdAt: "2026-09-27T10:00:00Z",
      fetchedAt: "2026-09-27T13:00:00Z",
      ...overrides,
    };
  }

  describe("Feature flags default behavior", () => {
    it("defaults ACTIVE_WORKING_SET_V0 to false", () => {
      expect(isActiveWorkingSetFeatureEnabled()).toBe(false);
    });

    it("defaults SKIP_UNCHANGED_NOT_DUE_V0 to false", () => {
      expect(isSkipUnchangedNotDueFeatureEnabled()).toBe(false);
    });

    it("returns 100% of input orders when ACTIVE_WORKING_SET_V0 is false", () => {
      const orders: NormalizedRillnetOrder[] = [
        createMockOrder({
          orderCode: "OLD_TERMINAL_1",
          status: "delivered",
          createdAt: "2026-08-01T00:00:00Z",
          endDeliveryAt: "2026-08-05T00:00:00Z",
        }),
      ];
      const res = selectActiveWorkingSet(orders, { referenceTimeMs: Date.parse("2026-09-27T13:00:00Z") });
      expect(res.workingSet.length).toBe(1);
      expect(res.reductionPercent).toBe(0);
    });
  });

  describe("Rule 1: Preserve every unresolved/non-terminal order regardless of age", () => {
    it("preserves 30-day-old unresolved order even when ACTIVE_WORKING_SET_V0 is true", () => {
      const orders: NormalizedRillnetOrder[] = [
        createMockOrder({
          orderCode: "OLD_UNRESOLVED_ORDER",
          status: "storing", // non-terminal!
          createdAt: "2026-08-25T00:00:00Z", // 33 days old
        }),
      ];

      const res = selectActiveWorkingSet(orders, {
        referenceTimeMs: Date.parse("2026-09-27T13:00:00Z"),
        forceEnabled: true,
      });

      expect(res.activeOrders).toBe(1);
      expect(res.workingSet.length).toBe(1);
      expect(res.workingSet[0].orderCode).toBe("OLD_UNRESOLVED_ORDER");
      expect(res.terminalOld).toBe(0);
    });
  });

  describe("Rule 2: Retain recent terminal transitions needed for reconciliation/closure", () => {
    it("retains terminal order delivered 2 days ago (within 7-day reconciliation window)", () => {
      const now = Date.parse("2026-09-27T13:00:00Z");
      const orders: NormalizedRillnetOrder[] = [
        createMockOrder({
          orderCode: "RECENT_DELIVERED_ORDER",
          status: "delivered",
          createdAt: "2026-09-20T00:00:00Z",
          endDeliveryAt: "2026-09-25T12:00:00Z", // 2 days ago
        }),
      ];

      const res = selectActiveWorkingSet(orders, {
        referenceTimeMs: now,
        forceEnabled: true,
      });

      expect(res.terminalRecent).toBe(1);
      expect(res.workingSet.length).toBe(1);
      expect(res.workingSet[0].orderCode).toBe("RECENT_DELIVERED_ORDER");
      expect(res.terminalOld).toBe(0);
    });
  });

  describe("Rule 3: Exclude old, already-finalized terminal orders from heavy processing", () => {
    it("excludes terminal order delivered 20 days ago (outside 7-day window)", () => {
      const now = Date.parse("2026-09-27T13:00:00Z");
      const orders: NormalizedRillnetOrder[] = [
        createMockOrder({
          orderCode: "OLD_DELIVERED_ORDER",
          status: "delivered",
          createdAt: "2026-09-01T00:00:00Z",
          endDeliveryAt: "2026-09-05T00:00:00Z", // 22 days ago
        }),
      ];

      const res = selectActiveWorkingSet(orders, {
        referenceTimeMs: now,
        forceEnabled: true,
      });

      expect(res.terminalOld).toBe(1);
      expect(res.workingSet.length).toBe(0);
      expect(res.reductionPercent).toBe(100);
    });
  });

  describe("Rule 4: Heavy process conditions", () => {
    const nowMs = Date.parse("2026-09-27T13:00:00Z");
    const baselineFp = computeMaterialFingerprint({
      status: "FOLLOWING_UP",
      memberCount: 10,
      backlogCount: 10,
    });

    it("heavy processes NEW cases", () => {
      const res = evaluateCaseHeavyProcessingSkip({
        currentFingerprint: baselineFp,
        previousFingerprint: baselineFp,
        nextCheckAt: new Date(nowMs + 3600000).toISOString(),
        nowMs,
        isNewCase: true,
      });
      expect(res.skipHeavyProcessing).toBe(false);
      expect(res.reason).toBe("NEW_CASE");
    });

    it("heavy processes materially CHANGED cases", () => {
      const newFp = computeMaterialFingerprint({
        status: "FOLLOWING_UP",
        memberCount: 12, // changed count!
        backlogCount: 10,
      });
      const res = evaluateCaseHeavyProcessingSkip({
        currentFingerprint: newFp,
        previousFingerprint: baselineFp,
        nextCheckAt: new Date(nowMs + 3600000).toISOString(),
        nowMs,
      });
      expect(res.skipHeavyProcessing).toBe(false);
      expect(res.reason).toBe("STATE_CHANGED");
    });

    it("heavy processes cases where next_check_at <= now", () => {
      const res = evaluateCaseHeavyProcessingSkip({
        currentFingerprint: baselineFp,
        previousFingerprint: baselineFp,
        nextCheckAt: new Date(nowMs - 60000).toISOString(), // 1 min ago (due!)
        nowMs,
      });
      expect(res.skipHeavyProcessing).toBe(false);
      expect(res.reason).toBe("DUE_FOR_RECHECK");
    });

    it("heavy processes cases where next_check_at is null or missing", () => {
      const res = evaluateCaseHeavyProcessingSkip({
        currentFingerprint: baselineFp,
        previousFingerprint: baselineFp,
        nextCheckAt: null,
        nowMs,
      });
      expect(res.skipHeavyProcessing).toBe(false);
      expect(res.reason).toBe("DUE_FOR_RECHECK");
    });

    it("heavy processes cases with terminal transition requiring closure", () => {
      const res = evaluateCaseHeavyProcessingSkip({
        currentFingerprint: baselineFp,
        previousFingerprint: baselineFp,
        nextCheckAt: new Date(nowMs + 3600000).toISOString(),
        nowMs,
        isTerminalTransition: true,
      });
      expect(res.skipHeavyProcessing).toBe(false);
      expect(res.reason).toBe("TERMINAL_TRANSITION");
    });
  });

  describe("Rule 5: Skip only UNCHANGED AND next_check_at > now", () => {
    const nowMs = Date.parse("2026-09-27T13:00:00Z");
    const baselineFp = computeMaterialFingerprint({
      status: "FOLLOWING_UP",
      memberCount: 10,
      backlogCount: 10,
    });

    it("skips only when fingerprint matches and next_check_at > now", () => {
      const res = evaluateCaseHeavyProcessingSkip({
        currentFingerprint: baselineFp,
        previousFingerprint: baselineFp,
        nextCheckAt: new Date(nowMs + 7200000).toISOString(), // 2 hours in the future
        nowMs,
      });
      expect(res.skipHeavyProcessing).toBe(true);
      expect(res.reason).toBe("UNCHANGED_AND_NOT_DUE");
    });
  });
});
