import { describe, expect, it } from "vitest";
import { canAccessWarehouse, resolveDataScope, selectWarehouseIds } from "@/security/data-scope";
import assignmentData from "@/data/warehouse-assignments.generated.json";

describe("warehouse/PIC data scope", () => {
  it("gives ADMIN the complete assignment dataset", () => {
    const scope = resolveDataScope("ADMIN", {}, {});
    expect(scope.mode).toBe("ALL");
    expect(scope.warehouseIds.length).toBe(1661);
  });

  it("resolves the signed-in employee across all three assignment levels", () => {
    const scope = resolveDataScope("OPERATOR", { opspilot_employee_id: "3115387" }, {});
    expect(scope.mode).toBe("ASSIGNED");
    expect(scope.warehouseIds).toHaveLength(112);
    expect(new Set(scope.warehouses.map((warehouse) => warehouse.zone))).toEqual(new Set(["Miền Bắc 3"]));
  });

  it("fails closed when an employee scope has not been assigned", () => {
    const scope = resolveDataScope("OPERATOR", {}, {});
    expect(scope.mode).toBe("UNASSIGNED");
    expect(scope.warehouseIds).toEqual([]);
    expect(canAccessWarehouse(scope, "20985000")).toBe(false);
  });

  it("intersects zone, PIC and warehouse selections with the account scope", () => {
    const scope = resolveDataScope("OPERATOR", { opspilot_employee_id: "3115387" }, {});
    expect(selectWarehouseIds(scope, "zone:Miền Bắc 3")).toHaveLength(112);
    expect(selectWarehouseIds(scope, "pic:3115387")).toHaveLength(112);
    expect(selectWarehouseIds(scope, "warehouse-not-assigned")).toEqual([]);
  });

  it("keeps the generated assignment dataset normalized and free of phone data", () => {
    const ids = assignmentData.warehouses.map((warehouse) => warehouse.warehouseId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(assignmentData.warehouses.some((warehouse) => warehouse.zone === "Miên Bắc 4")).toBe(false);
    expect(JSON.stringify(assignmentData).toLowerCase()).not.toContain("phone");
  });
});
