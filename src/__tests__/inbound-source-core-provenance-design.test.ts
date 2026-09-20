import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (name: string) => fs.readFileSync(path.join(process.cwd(), "src/database/migrations", name), "utf8");

describe("087D source-core provenance contract", () => {
  it("adds nullable manifest freshness without historical backfill and preserves RPC security", () => {
    const migration = read("087d_inbound_evidence_v2_source_core_provenance.sql");
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS source_freshness TIMESTAMPTZ NULL/i);
    expect(migration).not.toMatch(/\bUPDATE\s+public\.inbound_population_manifests\b/i);
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("REVOKE ALL PRIVILEGES");
    expect(migration).toContain("GRANT EXECUTE");
  });

  it("validates manifest truth instead of full-workflow success", () => {
    const migration = read("087d_inbound_evidence_v2_source_core_provenance.sql");
    expect(migration).not.toMatch(/sr\.status\s*=\s*'success'/i);
    expect(migration).toContain("v_manifest.population_completed_at IS NULL");
    expect(migration).toContain("v_manifest.source_freshness IS NULL");
    expect(migration).toContain("v_source_freshness <> v_manifest.source_freshness");
  });
});
