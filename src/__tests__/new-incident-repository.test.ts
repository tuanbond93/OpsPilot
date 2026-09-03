import { describe, it, expect, beforeEach, vi } from "vitest";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";
import { SupabaseIncidentRepository } from "@/repositories/supabase/SupabaseIncidentRepository";
import { MockIncidentRepository } from "@/repositories/mock/MockIncidentRepository";

import type { Incident } from "@/engine/incident/types";

describe("IncidentRepository Refactor Tests", () => {
  beforeEach(() => {
    RepositoryFactory.clear();
    vi.stubEnv("ALLOW_IN_MEMORY_FALLBACK", "true");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  });

  it("RepositoryFactory resolves MockIncidentRepository in test/fallback context", () => {
    const repo = RepositoryFactory.getIncidentRepository();
    expect(repo).toBeInstanceOf(MockIncidentRepository);
  });

  it("RepositoryFactory resolves SupabaseIncidentRepository in production/no-fallback context", () => {
    vi.stubEnv("ALLOW_IN_MEMORY_FALLBACK", "false");
    vi.stubEnv("NODE_ENV", "production");

    const repo = RepositoryFactory.getIncidentRepository();
    expect(repo).toBeInstanceOf(SupabaseIncidentRepository);
  });

  it("MockIncidentRepository provides deterministic CRUD/read behavior", async () => {
    const mockRepo = new MockIncidentRepository();
    const incObj: Incident = {
      incidentId: "inc-1",
      incidentKey: "inc-key-1",
      warehouseId: "w-1",
      warehouseName: "Kho 1",
      reasonCode: "KHO_TON",
      reasonName: "Kho tồn",
      status: "open",
      priorityScore: 1,
      firstDetectedAt: "2026-08-06T10:00:00Z",
      lastDetectedAt: "2026-08-06T10:00:00Z",
      affectedOrderCount: 1,
      sampleOrderCodes: ["order-1"],
      averageAgeHours: 1,
      maximumAgeHours: 1,
      oldestOrderCode: "order-1",
    };

    const upserted = await mockRepo.upsertIncidents([incObj], "sync-run-1");
    expect(upserted.length).toBe(1);
    expect(upserted[0].incident_key).toBe("inc-key-1");

    const openIncidents = await mockRepo.getOpenIncidents();
    expect(openIncidents.length).toBe(1);

    const resolvedCount = await mockRepo.resolveAbsentIncidents([], "sync-run-1");
    expect(resolvedCount).toBe(1);

    const openIncidentsAfter = await mockRepo.getOpenIncidents();
    expect(openIncidentsAfter.length).toBe(0);
  });

  it("SupabaseIncidentRepository throws queries errors and does not silently fall back", async () => {
    const mockClient = {
      from: vi.fn().mockReturnThis(),
      upsert: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: null, error: new Error("Supabase internal error") }),
    } as any;

    const supabaseRepo = new SupabaseIncidentRepository(mockClient);
    const incObj: Incident = {
      incidentId: "inc-1",
      incidentKey: "inc-key-1",
      warehouseId: "w-1",
      warehouseName: "Kho 1",
      reasonCode: "KHO_TON",
      reasonName: "Kho tồn",
      status: "open",
      priorityScore: 1,
      firstDetectedAt: "2026-08-06T10:00:00Z",
      lastDetectedAt: "2026-08-06T10:00:00Z",
      affectedOrderCount: 1,
      sampleOrderCodes: ["order-1"],
      averageAgeHours: 1,
      maximumAgeHours: 1,
      oldestOrderCode: "order-1",
    };

    await expect(supabaseRepo.upsertIncidents([incObj], "sync-run-1")).rejects.toThrow("Supabase internal error");
  });
});
