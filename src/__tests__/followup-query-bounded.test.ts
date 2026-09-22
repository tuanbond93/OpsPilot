import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FollowupCaseRow } from "@/connectors/supabase/types";
import { SupabaseFollowupRepository } from "@/repositories/supabase/SupabaseFollowupRepository";

function makeCase(index: number, updatedAt: string, currentState: FollowupCaseRow["current_state"] = index === 0 ? "CLOSED" : "FOLLOWING_UP"): FollowupCaseRow {
  return {
    id: `case-${String(index).padStart(3, "0")}`,
    incident_id: `incident-${index}`,
    incident_key: `warehouse-${index}:KHO_TON`,
    current_state: currentState,
    first_detected_at: "2026-09-21T01:00:00.000Z",
    last_checked_at: updatedAt,
    next_action_at: null,
    last_action_requested_at: null,
    last_action_confirmed_at: null,
    resolved_at: null,
    closed_at: index === 0 ? updatedAt : null,
    baseline_affected_order_count: 10,
    latest_affected_order_count: 10,
    current_progress_percent: 0,
    current_assessment: "no_progress",
    current_rillnet_status_signature: "",
    last_action_rillnet_status_signature: null,
    rillnet_change_summary: null,
    rillnet_changed_at: null,
    rillnet_review_before_signature: null,
    rillnet_review_after_signature: null,
    rillnet_review_detected_at: null,
    rillnet_review_snapshot_id: null,
    rillnet_review_order_codes: null,
    operational_cohort: null,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

function pagedClient(batches: FollowupCaseRow[][]) {
  const builders: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
  let batchIndex = 0;
  const client = {
    from: vi.fn(() => {
      const batch = batches[batchIndex++] || [];
      const builder: Record<string, ReturnType<typeof vi.fn>> = {};
      builder.select = vi.fn(() => builder);
      builder.order = vi.fn(() => builder);
      builder.neq = vi.fn(() => builder);
      builder.limit = vi.fn(() => builder);
      builder.or = vi.fn(() => builder);
      builder.then = vi.fn((resolve: (value: { data: FollowupCaseRow[]; error: null }) => unknown) =>
        Promise.resolve(resolve({ data: batch, error: null })));
      builders.push(builder);
      return builder;
    }),
  } as unknown as SupabaseClient;
  return { client, builders };
}

describe("bounded follow-up case reads", () => {
  it("uses deterministic keyset pages without skipping or duplicating equal-timestamp rows", async () => {
    const updatedAt = "2026-09-22T11:00:00.000Z";
    const rows = Array.from({ length: 205 }, (_, index) => makeCase(204 - index, updatedAt));
    const { client, builders } = pagedClient([
      rows.slice(0, 100),
      rows.slice(100, 200),
      rows.slice(200),
    ]);

    const result = await new SupabaseFollowupRepository(client).getAllCases();

    expect(result.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(new Set(result.map((row) => row.id)).size).toBe(rows.length);
    expect(result.at(-1)?.current_state).toBe("CLOSED");
    expect(builders).toHaveLength(3);
    for (const builder of builders) {
      expect(builder.limit).toHaveBeenCalledWith(100);
      expect(builder.select).toHaveBeenCalledWith(expect.not.stringMatching(/^\*$/));
      expect(builder.order).toHaveBeenCalledWith("updated_at", { ascending: false });
      expect(builder.order).toHaveBeenCalledWith("id", { ascending: false });
    }
    expect(builders[1].or).toHaveBeenCalledWith(expect.stringContaining("updated_at.eq.2026-09-22T11:00:00.000Z"));
    expect(builders[1].or).toHaveBeenCalledWith(expect.stringContaining("id.lt.case-105"));
    expect(builders[2].or).toHaveBeenCalledWith(expect.stringContaining("id.lt.case-005"));
  });

  it("handles an empty table with one bounded query", async () => {
    const { client, builders } = pagedClient([[]]);

    await expect(new SupabaseFollowupRepository(client).getAllCases()).resolves.toEqual([]);

    expect(builders).toHaveLength(1);
    expect(builders[0].limit).toHaveBeenCalledWith(100);
  });

  it("uses only processing fields and excludes CLOSED cases for engine pages", async () => {
    const updatedAt = "2026-09-22T11:00:00.000Z";
    const rows = Array.from({ length: 100 }, (_, index) => makeCase(100 - index, updatedAt, "FOLLOWING_UP"));
    const { client, builders } = pagedClient([rows]);

    const page = await new SupabaseFollowupRepository(client).getOperationalCasesPage();

    expect(page.cases.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(page.nextCursor).toEqual({ updatedAt, id: rows.at(-1)?.id });
    expect(builders[0].neq).toHaveBeenCalledWith("current_state", "CLOSED");
    expect(builders[0].select).toHaveBeenCalledWith(expect.stringContaining("operational_cohort"));
    expect(builders[0].select).toHaveBeenCalledWith(expect.not.stringMatching(/closed_at/));
  });
});
