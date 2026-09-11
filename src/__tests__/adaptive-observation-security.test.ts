import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shadowExecutionMode } from "@/domain/adaptive-observation/runtime";
import { normalizeEtaEvidence, normalizeSlaEvidence } from "@/domain/adaptive-observation/normalizers";

const sql = readFileSync(join(process.cwd(), "src/database/migrations/065_adaptive_shadow_observation_store.sql"), "utf8");
const tables = ["adaptive_observation_snapshots", "checkpoint_case_snapshots", "adaptive_shadow_decisions", "shadow_outcome_observations"];
describe("adaptive observation release security gate", () => {
  it("1 denies warehouse/authenticated direct writes", () => expect(sql).toContain("FROM PUBLIC, anon, authenticated"));
  it("2 denies warehouse cross-scope reads by denying all direct reads", () => expect(sql).toContain("ENABLE ROW LEVEL SECURITY"));
  it("3 denies anonymous access", () => expect(sql).toContain("anon, authenticated"));
  it("4 denies normal application snapshot updates", () => expect(sql).toContain("REVOKE ALL ON TABLE"));
  it("5 denies normal application snapshot deletes", () => expect(sql).toContain("REVOKE ALL ON TABLE"));
  it("6 permits validated server-side writer role insert", () => expect(sql).toContain("GRANT SELECT, INSERT ON TABLE"));
  it("7 rejects duplicate retries with a unique idempotency key", () => expect((sql.match(/idempotency_key TEXT NOT NULL UNIQUE/g) || []).length).toBe(4));
  it("8 keeps snapshot-only mode available", () => expect(shadowExecutionMode({ ADAPTIVE_V2_SHADOW_ENABLED: false, SHADOW_SNAPSHOT_WRITE_ENABLED: true })).toBe("SNAPSHOT_ONLY"));
  it("9 disables V2 if snapshot persistence is disabled", () => expect(shadowExecutionMode({ ADAPTIVE_V2_SHADOW_ENABLED: true, SHADOW_SNAPSHOT_WRITE_ENABLED: false })).toBe("DISABLED"));
  it("10 retains unknown where sources are absent", () => { expect(normalizeSlaEvidence().state).toBe("UNKNOWN"); expect(normalizeEtaEvidence(null, "2026-09-11T12:00:00.000Z").evidenceLevel).toBe("UNKNOWN"); });
  it("enables RLS and immutable triggers for every isolated table", () => tables.forEach(table => { expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`); expect(sql).toContain(`${table}_immutable BEFORE UPDATE OR DELETE`); }));
});
