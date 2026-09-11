import { describe, expect, it } from "vitest";
import { ADAPTIVE_OBSERVATION_SCHEMA_VERSION, type AdaptiveObservationSnapshot } from "@/domain/adaptive-observation/contracts";
import { appendObservation, runV1WithIsolatedShadow } from "@/domain/adaptive-observation/isolation";
import { normalizeCommitmentEvidence, normalizeEtaEvidence, normalizeProgressEvidence, normalizeSlaEvidence, responseToEvidence } from "@/domain/adaptive-observation/normalizers";

const at = "2026-09-11T02:00:00.000Z";
const snapshot = (id = "s1"): AdaptiveObservationSnapshot => ({ snapshotId: id, caseId: "c1", incidentId: "i1", observedAt: at, trigger: "12:00", schemaVersion: ADAPTIVE_OBSERVATION_SCHEMA_VERSION, scope: { region: null, province: null, warehouse: "MB3", issueType: "KHO_TON" }, incident: { currentState: "ACTIVE", resolutionState: "ACTIVE", resolvedAt: null }, backlog: { currentAffectedOrders: 3, previousAffectedOrders: 5, trend: "DECREASED", backlogAgeMinutes: 60, meaningfulProgress: true }, progress: { routeAssigned: null, driverAssigned: null, deliveryStarted: null, latestOperationalEventAt: null, progressState: "UNKNOWN" }, sla: normalizeSlaEvidence(), eta: normalizeEtaEvidence(null, at), exception: { state: "UNKNOWN", type: null, source: null, createdAt: null, expiresAt: null, confidence: "UNKNOWN" }, commitment: normalizeCommitmentEvidence(undefined, at), interventions: { lastConfirmedInterventionType: null, lastConfirmedInterventionAt: null, interventionsToday: null, lastRecipient: null, operatorRespondedAfterLastIntervention: null }, operatorResponse: { respondedAt: null, responseCode: null, structuredReason: null, actor: null, updateId: null, confidence: "UNKNOWN" }, evidenceQuality: { completeness: "UNKNOWN", missingFields: ["SLA"], ambiguousFields: [], staleFields: [] } });

describe("adaptive observation layer V0", () => {
  it("1 unknown SLA", () => expect(normalizeSlaEvidence().state).toBe("UNKNOWN"));
  it("2 conflicting SLA", () => expect(normalizeSlaEvidence([{ requiredBy: "2026-09-11T03:00:00Z", source: "A", evidenceLevel: "A" }, { requiredBy: "2026-09-11T04:00:00Z", source: "B", evidenceLevel: "B" }]).state).toBe("AMBIGUOUS"));
  it("3 trusted ETA", () => expect(normalizeEtaEvidence({ eta: "2026-09-11T03:00:00Z", source: "route", evidenceLevel: "TRUSTED_OPERATIONAL" }, at).confidence).toBe("HIGH"));
  it("4 expired ETA", () => expect(normalizeEtaEvidence({ eta: "2026-09-11T01:00:00Z", source: "route", evidenceLevel: "TRUSTED_OPERATIONAL" }, at).expired).toBe(true));
  it("5 weak ETA", () => expect(normalizeEtaEvidence({ eta: "2026-09-11T03:00:00Z", source: "chat", evidenceLevel: "WEAK" }, at).confidence).toBe("LOW"));
  it("6 route assigned", () => expect(normalizeProgressEvidence({ routeAssigned: true })).toBe("ROUTE_ASSIGNED"));
  it("7 driver assigned", () => expect(normalizeProgressEvidence({ driverAssigned: true })).toBe("DRIVER_ASSIGNED"));
  it("8 delivery started", () => expect(normalizeProgressEvidence({ deliveryStarted: true })).toBe("IN_PROGRESS"));
  it("9 unknown progress", () => expect(normalizeProgressEvidence()).toBe("UNKNOWN"));
  it("10 active commitment", () => expect(normalizeCommitmentEvidence([{ actor: "lead", committedAt: "2026-09-11T01:00:00Z", committedCompletionAt: "2026-09-11T03:00:00Z", source: "miniapp" }], at).state).toBe("ACTIVE"));
  it("11 expired commitment", () => expect(normalizeCommitmentEvidence([{ actor: "lead", committedAt: "2026-09-11T01:00:00Z", committedCompletionAt: "2026-09-11T01:30:00Z", source: "miniapp" }], at).state).toBe("EXPIRED"));
  it("12 no commitment", () => expect(normalizeCommitmentEvidence([], at).state).toBe("NONE"));
  it("13 append-only snapshots reject replacement", () => expect(() => appendObservation([snapshot()], snapshot())).toThrow("DUPLICATE_SNAPSHOT_ID"));
  it("14 excludes future commitment evidence", () => expect(normalizeCommitmentEvidence([{ actor: "lead", committedAt: "2026-09-11T03:00:00Z", committedCompletionAt: "2026-09-11T04:00:00Z", source: "miniapp" }], at).state).toBe("NONE"));
  it("15 records independent population membership", () => expect({ engineMember: true, telegramStatusMember: false, dashboardMember: true }).toEqual({ engineMember: true, telegramStatusMember: false, dashboardMember: true }));
  it("16 links decisions to the exact snapshot id", () => expect({ snapshotId: snapshot().snapshotId, caseId: snapshot().caseId }).toEqual({ snapshotId: "s1", caseId: "c1" }));
  it("17 shadow cannot change V1 result", async () => expect((await runV1WithIsolatedShadow(async () => ({ state: "V1_RESULT" }), async () => {})).v1).toEqual({ state: "V1_RESULT" }));
  it("18 shadow failure cannot stop V1", async () => expect(await runV1WithIsolatedShadow(async () => "v1", async () => { throw new Error("shadow"); })).toEqual({ v1: "v1", shadowFailed: true }));
  it("19 creates no operational action", () => expect(runV1WithIsolatedShadow.toString()).not.toMatch(/NotificationService|enqueue|dispatch/i));
  it("20 snapshot normalizers are deterministic", () => expect(normalizeEtaEvidence({ eta: "2026-09-11T03:00:00Z", source: "route", evidenceLevel: "TRUSTED_OPERATIONAL" }, at)).toEqual(normalizeEtaEvidence({ eta: "2026-09-11T03:00:00Z", source: "route", evidenceLevel: "TRUSTED_OPERATIONAL" }, at)));
  it("21 stamps schema version", () => expect(snapshot().schemaVersion).toBe("v0"));
  it("22 preserves UNKNOWN", () => expect(snapshot().progress.progressState).toBe("UNKNOWN"));
  it("23 maps structured employee response", () => expect(responseToEvidence({ type: "CANNOT_COMPLETE", reason: "NO_VEHICLE" }).structuredReason).toBe("NO_VEHICLE"));
  it("24 observes a fulfilled commitment", () => expect(normalizeCommitmentEvidence([{ actor: "lead", committedAt: "2026-09-11T01:00:00Z", committedCompletionAt: "2026-09-11T03:00:00Z", source: "miniapp", completed: true }], at).state).toBe("COMPLETED"));
  it("25 observes a broken commitment", () => expect(normalizeCommitmentEvidence([{ actor: "lead", committedAt: "2026-09-11T00:00:00Z", committedCompletionAt: "2026-09-11T01:00:00Z", source: "miniapp" }], at).state).toBe("EXPIRED"));
});
