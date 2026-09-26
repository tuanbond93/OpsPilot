import { describe, expect, it } from "vitest";
import {
  CheckpointShadowRunner,
  type V1CheckpointSummary,
} from "@/engine/checkpoint-v2/checkpoint-shadow-runner";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet/types";

describe("Checkpoint Pipeline V2 - Shadow Production Parity Runner", () => {
  function makeMockOrders(count: number): NormalizedRillnetOrder[] {
    const orders: NormalizedRillnetOrder[] = [];
    for (let i = 0; i < count; i++) {
      orders.push({
        id: `id_shadow_${i + 1}`,
        orderCode: `ORD_SHADOW_${i + 1}`,
        status: "storing",
        taskCategory: "storing",
        warehouseId: "WH_HNI_01",
        warehouseName: "Kho Hub Hà Nội",
        customerId: "CUST_001",
        customerName: "Khách hàng 1",
        customerCode: "CUST_CODE_1",
        createdAt: "2026-09-26T00:00:00.000Z",
        deliverWarehouseId: "WH_SGN_01",
        warehouseLog: [],
        endPickAt: "2026-09-26T06:00:00.000Z",
        fetchedAt: "2026-09-26T07:00:00.000Z",
      });
    }
    return orders;
  }

  it("executes shadow comparison across 4 simulated production checkpoints with 100% parity", async () => {
    const runner = new CheckpointShadowRunner();

    const simulatedCheckpoints: V1CheckpointSummary[] = [
      {
        syncRunId: "run_prod_08h",
        checkpointAt: "2026-09-26T01:00:00.000Z", // 08h
        orderCount: 14_469,
        incidentCount: 3_600,
        caseCount: 85,
        memberCount: 2_100,
        decisionsCount: 85,
        interventionTypes: ["TELEGRAM_FIRST_PUSH"],
      },
      {
        syncRunId: "run_prod_10h",
        checkpointAt: "2026-09-26T03:00:00.000Z", // 10h
        orderCount: 8_200,
        incidentCount: 1_950,
        caseCount: 42,
        memberCount: 1_100,
        decisionsCount: 42,
        interventionTypes: ["TELEGRAM_FIRST_PUSH", "TELEGRAM_FOLLOW_UP"],
      },
      {
        syncRunId: "run_prod_14h",
        checkpointAt: "2026-09-26T07:00:00.000Z", // 14h
        orderCount: 6_293,
        incidentCount: 1_600,
        caseCount: 47,
        memberCount: 1_250,
        decisionsCount: 47,
        interventionTypes: ["TELEGRAM_FIRST_PUSH"],
      },
      {
        syncRunId: "run_prod_18h",
        checkpointAt: "2026-09-26T11:00:00.000Z", // 18h
        orderCount: 18_500,
        incidentCount: 4_500,
        caseCount: 120,
        memberCount: 3_400,
        decisionsCount: 120,
        interventionTypes: ["TELEGRAM_FIRST_PUSH", "TELEGRAM_FOLLOW_UP"],
      },
    ];

    const reports = [];

    for (const v1 of simulatedCheckpoints) {
      const orders = makeMockOrders(v1.orderCount);
      const report = await runner.runShadowComparison(v1, orders);

      expect(report.isShadow).toBe(true);
      expect(report.parity.orderPopulationMatches).toBe(true);
      expect(report.parity.caseCountMatches).toBe(true);
      expect(report.parity.overallParity).toBe(true);
      expect(report.v2Summary.telegramSuppressedCount).toBe(v1.caseCount);
      expect(report.parity.unexplainedDifferences).toHaveLength(0);

      reports.push(report);
    }

    expect(reports).toHaveLength(4);
  });
});
