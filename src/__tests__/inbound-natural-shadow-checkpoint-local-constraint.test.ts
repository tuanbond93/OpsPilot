import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sqlRegex = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?[+]07:00$";
const equivalentRegex = new RegExp(sqlRegex);

describe("087E Natural Shadow checkpoint_at_local constraint", () => {
  it("uses a forward-only replacement for the exact live constraint", () => {
    const migration = readFileSync(join(process.cwd(), "src", "database", "migrations", "087e_fix_inbound_evidence_v2_checkpoint_local_constraint.sql"), "utf8");
    expect(migration).toContain("DROP CONSTRAINT inbound_evidence_v2_natural_shadow_ch_checkpoint_at_local_check");
    expect(migration).toContain("ADD CONSTRAINT inbound_evidence_v2_natural_shadow_ch_checkpoint_at_local_check");
    expect(migration).toContain(sqlRegex);
    expect(migration).not.toContain("\\\\d");
  });

  it("accepts governed local checkpoint values", () => {
    expect(equivalentRegex.test("2026-09-21T14:00:00+07:00")).toBe(true);
    expect(equivalentRegex.test("2026-09-21T14:00:00.123+07:00")).toBe(true);
  });

  it("rejects malformed or non-governed offsets", () => {
    for (const value of [
      "2026-09-21 14:00:00+07:00",
      "2026-09-21T14:00:00Z",
      "2026-09-21T14:00:00+00:00",
      "2026/09/21T14:00:00+07:00",
    ]) expect(equivalentRegex.test(value)).toBe(false);
  });
});
