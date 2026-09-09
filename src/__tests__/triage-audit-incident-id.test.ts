import { describe, expect, it, vi } from "vitest";
import {
  canonicalIncidentIds,
  SupabaseTriageAuditRepository,
} from "@/repositories/supabase/SupabaseTriageAuditRepository";

const UUID_A = "106504ad-8ae7-4a5f-b756-b30b01b1aa21";
const UUID_B = "106504ad-8ae7-4a5f-b756-b30b01b1aa22";
const LOGICAL_KEY = "21152000:KHO_TON";

function clientReturning(rows: unknown[] = []) {
  const order = vi.fn().mockResolvedValue({ data: rows, error: null });
  const inQuery = vi.fn().mockReturnValue({ order });
  const select = vi.fn().mockReturnValue({ in: inQuery });
  const from = vi.fn().mockReturnValue({ select });
  return { client: { from } as any, from, inQuery };
}

describe("triage audit incident UUID boundary", () => {
  it("does not send the production logical key to the UUID query", async () => {
    const { client, from } = clientReturning();
    const repository = new SupabaseTriageAuditRepository(client);

    await expect(repository.getLatestByIncidentIds([LOGICAL_KEY])).resolves.toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  it("passes a valid incident UUID through unchanged", async () => {
    const { client, inQuery } = clientReturning();
    await new SupabaseTriageAuditRepository(client).getLatestByIncidentIds([UUID_A]);
    expect(inQuery).toHaveBeenCalledWith("incident_id", [UUID_A]);
  });

  it("removes logical keys from a mixed population without generating UUIDs", async () => {
    const { client, inQuery } = clientReturning();
    await new SupabaseTriageAuditRepository(client).getLatestByIncidentIds([UUID_A, LOGICAL_KEY, UUID_B, UUID_A]);
    expect(inQuery).toHaveBeenCalledWith("incident_id", [UUID_A, UUID_B]);
  });

  it("short-circuits an empty population", async () => {
    const { client, from } = clientReturning();
    await expect(new SupabaseTriageAuditRepository(client).getLatestByIncidentIds([])).resolves.toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  it("preserves a production-sized canonical population", () => {
    const ids = Array.from({ length: 295 }, (_, index) =>
      `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`
    );
    expect(canonicalIncidentIds([...ids, LOGICAL_KEY])).toEqual(ids);
  });
});
