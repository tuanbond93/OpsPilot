import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServiceFactory } from "@/services/ServiceFactory";
import { ProjectionService } from "@/services/impl/ProjectionService";
import { refresh } from "@/projections/projection-engine";
import type { IWarehouseProjection } from "@/projections/interfaces/IWarehouseProjection";
import type { IIncidentProjection } from "@/projections/interfaces/IIncidentProjection";
import type { IPlannerProjection } from "@/projections/interfaces/IPlannerProjection";
import type { INotificationProjection } from "@/projections/interfaces/INotificationProjection";
import type { IProjectionRunRepository } from "@/repositories/interfaces/IProjectionRunRepository";
import * as supabaseConnector from "@/connectors/supabase";

describe("Sprint 8.10 Hardening — ProjectionService Architecture & Injection Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("1. ServiceFactory resolves ProjectionService instance", () => {
    const service = ServiceFactory.getProjectionService();
    expect(service).toBeInstanceOf(ProjectionService);
  });

  it("2. ProjectionService accepts pure port interface doubles without SupabaseClient", async () => {
    const warehouseSpy = vi.fn().mockResolvedValue({ status: "success", rowsUpdated: 5, durationMs: 10 });
    const incidentSpy = vi.fn().mockResolvedValue({ status: "success", rowsUpdated: 3, durationMs: 8 });
    const plannerSpy = vi.fn().mockResolvedValue({ status: "success", rowsUpdated: 2, durationMs: 5 });
    const notifSpy = vi.fn().mockResolvedValue({ status: "success", rowsUpdated: 1, durationMs: 4 });

    const mockWarehouse: IWarehouseProjection = { project: warehouseSpy };
    const mockIncident: IIncidentProjection = { project: incidentSpy };
    const mockPlanner: IPlannerProjection = { project: plannerSpy };
    const mockNotif: INotificationProjection = { project: notifSpy };
    const mockRepo: IProjectionRunRepository = { getLatestRun: vi.fn().mockResolvedValue({ id: "run-1" }) };

    const service = new ProjectionService(
      mockWarehouse,
      mockIncident,
      mockPlanner,
      mockNotif,
      mockRepo
    );

    await service.refreshProjections();

    expect(warehouseSpy).toHaveBeenCalledTimes(1);
    expect(incidentSpy).toHaveBeenCalledTimes(1);
    expect(plannerSpy).toHaveBeenCalledTimes(1);
    expect(notifSpy).toHaveBeenCalledTimes(1);

    const latest = await service.getLatestRun();
    expect(latest.id).toBe("run-1");
  });

  it("3. ProjectionEngine delegates to ProjectionService via ServiceFactory", async () => {
    vi.spyOn(supabaseConnector, "createAdminClient").mockReturnValue({} as any);
    const refreshSpy = vi.fn().mockResolvedValue(undefined);
    const mockService = { refreshProjections: refreshSpy } as any;
    vi.spyOn(ServiceFactory, "getProjectionService").mockReturnValue(mockService);

    await refresh({
      source: "sync",
      changedIncidentIds: ["inc-1"],
      changedWarehouseIds: ["wh-1"],
    });

    expect(ServiceFactory.getProjectionService).toHaveBeenCalled();
    expect(refreshSpy).toHaveBeenCalledWith({
      source: "sync",
      changedIncidentIds: ["inc-1"],
      changedWarehouseIds: ["wh-1"],
    });
  });
});
