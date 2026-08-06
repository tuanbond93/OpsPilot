import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServiceFactory } from "@/services/ServiceFactory";
import { IncidentService } from "@/services/impl/IncidentService";
import { MockIncidentRepository } from "@/repositories/mock/MockIncidentRepository";
import { MockIncidentHistoryRepository } from "@/repositories/mock/MockIncidentHistoryRepository";

describe("Sprint 8.9 — IncidentService Architecture & Execution Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("1. ServiceFactory resolves IncidentService with injected dependencies", () => {
    const service = ServiceFactory.getIncidentService();
    expect(service).toBeInstanceOf(IncidentService);
  });

  it("2. IncidentService returns history formatting for known incidents", async () => {
    const incidentRepo = new MockIncidentRepository();
    const historyRepo = new MockIncidentHistoryRepository();
    const service = new IncidentService(incidentRepo, historyRepo);

    const res = await service.getIncidentHistory("inc-unknown");
    expect(res).toBeDefined();
    expect(res.incident).toBeDefined();
    expect(Array.isArray(res.history)).toBe(true);
  });
});
