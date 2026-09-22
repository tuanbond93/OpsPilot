import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseInboundOrderObservationRepository } from "@/repositories/supabase/SupabaseInboundOrderObservationRepository";
import type { InboundPopulationManifestInput } from "@/repositories/interfaces/IInboundOrderObservationRepository";

const input: InboundPopulationManifestInput = {
  sync_run_id: "00000000-0000-4000-8000-000000000001",
  source_system: "RILLNET",
  normalized_population_count: 9683,
  expected_observation_count: 9683,
  duplicate_identical_count: 0,
  duplicate_conflict_count: 0,
  source_freshness: "2026-09-22T01:00:00.000Z",
};

function chain<T>(result: T) {
  const builder: any = {
    eq: vi.fn(() => builder),
    neq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
  };
  return builder;
}

describe("SupabaseInboundOrderObservationRepository replacement contract", () => {
  it("resets the manifest before deleting the incomplete run population", async () => {
    const manifestSelect = chain({ data: { population_status: "FAILED" }, error: null });
    const manifestUpsert = vi.fn().mockResolvedValue({ error: null });
    const observationsDelete = chain({ error: null });
    const from = vi.fn((table: string) => {
      if (table === "inbound_population_manifests") {
        return {
          select: vi.fn(() => manifestSelect),
          upsert: manifestUpsert,
        };
      }
      return { delete: vi.fn(() => observationsDelete) };
    });

    const repository = new SupabaseInboundOrderObservationRepository({ from } as unknown as SupabaseClient);
    await repository.replaceIncompletePopulation(input);

    expect(manifestUpsert).toHaveBeenCalledWith(expect.objectContaining({
      sync_run_id: input.sync_run_id,
      population_status: "STARTED",
      persisted_observation_count: 0,
    }), { onConflict: "sync_run_id,source_system" });
    expect(from).toHaveBeenNthCalledWith(3, "inbound_order_observations");
    expect(observationsDelete.eq).toHaveBeenCalledWith("sync_run_id", input.sync_run_id);
    expect(observationsDelete.eq).toHaveBeenCalledWith("source_system", input.source_system);
  });

  it("rejects completed populations before any replacement write", async () => {
    const manifestSelect = chain({ data: { population_status: "COMPLETE" }, error: null });
    const manifestUpsert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn(() => ({
      select: vi.fn(() => manifestSelect),
      upsert: manifestUpsert,
      delete: vi.fn(),
    }));

    const repository = new SupabaseInboundOrderObservationRepository({ from } as unknown as SupabaseClient);
    await expect(repository.replaceIncompletePopulation(input)).rejects.toThrow(
      "INBOUND_POPULATION_REPLACEMENT_FORBIDDEN_COMPLETED",
    );
    expect(manifestUpsert).not.toHaveBeenCalled();
  });
});
