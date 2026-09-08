import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseOrderSnapshotRepository } from "@/repositories/supabase/SupabaseOrderSnapshotRepository";

describe("SupabaseOrderSnapshotRepository hold data contract", () => {
  it("persists normalized hold fields without changing snapshot selection", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockReturnValue({ upsert });
    const repository = new SupabaseOrderSnapshotRepository({ from } as unknown as SupabaseClient);

    const snapshot = {
      sync_run_id: "sync-1",
      order_code: "ORDER-1",
      warehouse_id: "100",
      source_status: "storing",
      deliver_warehouse_name: "Kho giao cuối",
      destination_province_id: "79",
      destination_district_id: "145",
      weight_grams: 233556,
      weight_kg: 233.556,
      sort_code: "A1",
      is_b2b: true,
    };

    await expect(repository.insertBatch([snapshot])).resolves.toBe(1);
    expect(from).toHaveBeenCalledWith("order_snapshots");
    expect(upsert).toHaveBeenCalledWith([snapshot], {
      onConflict: "sync_run_id,order_code,warehouse_id,source_status",
      ignoreDuplicates: true,
    });
  });
});
