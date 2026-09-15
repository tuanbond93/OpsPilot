import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { NearTermCapacityRuntimeService } from "@/services/near-term-capacity-runtime";

describe("near-term capacity detector telemetry", () => {
  it("keeps telemetry server-only, bounded, and indexed", () => {
    const sql = fs.readFileSync("src/database/migrations/074_near_term_capacity_detector_telemetry.sql", "utf8");
    expect(sql).toContain("near_term_capacity_checkpoint_telemetry");
    expect(sql).toContain("near_term_capacity_detector_telemetry");
    expect(sql).toContain("ALTER TABLE public.near_term_capacity_checkpoint_telemetry ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE public.near_term_capacity_detector_telemetry ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("idx_near_term_capacity_detector_telemetry_result");
    expect(sql).not.toMatch(/CREATE\s+POLICY|USING\s*\(\s*true\s*\)|WITH\s+CHECK\s*\(\s*true\s*\)/i);
  });

  it("records a zero-candidate rejection batch without changing the result", async () => {
    const telemetryWrites: Array<{ table: string; payload: Record<string, unknown> }> = [];
    const from = vi.fn((table: string) => {
      if (table === "near_term_capacity_cases") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      if (table === "incidents") return { select: () => ({ in: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [{ id: "i-1", incident_key: "W1:KHO_TON", warehouse_id: "W1", warehouse_name: "Kho 1", reason_code: "KHO_TON", last_detected_at: new Date().toISOString() }], error: null }) }) }) }) }) };
      if (table === "incident_history") return { select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) };
      if (table.includes("telemetry")) return { upsert: async (payload: Record<string, unknown>) => { telemetryWrites.push({ table, payload }); return { error: null }; } };
      throw new Error(`Unexpected table ${table}`);
    });

    const result = await new NearTermCapacityRuntimeService({ from } as any).runCheckpoint("test", { checkpointAt: "2026-09-15T11:00:00.000Z", syncRunId: "123e4567-e89b-42d3-a456-426614174000" });
    expect(result).toMatchObject({ status: "NO_CANDIDATE", risk_candidates: 0, fact_requests_sent: 0 });
    expect(telemetryWrites.map((item) => item.table)).toEqual(expect.arrayContaining(["near_term_capacity_detector_telemetry", "near_term_capacity_checkpoint_telemetry"]));
    expect(telemetryWrites.find((item) => item.table.includes("detector"))?.payload).toMatchObject({ detector_result: "REJECTED", rejection_reason: "MISSING_REQUIRED_SIGNAL", current_orders_availability: "MISSING" });
    expect(telemetryWrites.find((item) => item.table.includes("checkpoint"))?.payload).toMatchObject({ incidents_scanned: 1, candidates_detected: 0, rejected_count: 1, missing_signal_count: 1 });
  });

  it("isolates telemetry write failures from the existing checkpoint result", async () => {
    const from = vi.fn((table: string) => {
      if (table === "near_term_capacity_cases") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "existing", active: true }, error: null }) }) }) };
      if (table.includes("telemetry")) return { upsert: async () => { throw new Error("telemetry unavailable"); } };
      throw new Error(`Unexpected table ${table}`);
    });
    await expect(new NearTermCapacityRuntimeService({ from } as any).runCheckpoint("test", { checkpointAt: "2026-09-15T11:00:00.000Z", syncRunId: "123e4567-e89b-42d3-a456-426614174000" })).resolves.toMatchObject({ status: "ACTIVE_CASE_EXISTS", fact_requests_sent: 0 });
  });
});
