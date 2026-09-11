import { describe, expect, it } from "vitest";
import { evaluateV2Snapshot, reconstructV1Action, snapshotCaseAt, snapshotToV2State } from "@/domain/adaptive-replay/normalizer";
import { classifyReplay, replayAdaptiveBaseline, reviewWait } from "@/domain/adaptive-replay/replay";
import type { CaseEvidenceRecord } from "@/domain/historical-evidence/reader";

const observedAt = "2026-09-10T02:00:00.000Z";
const record = (overrides: Partial<CaseEvidenceRecord> = {}): CaseEvidenceRecord => ({
  caseId: "case-1", incidentId: "incident-1", incidentKey: "MB3:KHO_TON", warehouseId: "MB3", warehouseName: "MB3", province: "HCM", region: "SOUTH", issueType: "KHO_TON", detectedAt: "2026-09-10T00:00:00.000Z", historicalState: "AVAILABLE",
  incidentHistory: [{ recordedAt: "2026-09-10T00:30:00.000Z", affectedOrderCount: 10, orderCodes: ["O1"] }, { recordedAt: "2026-09-10T01:30:00.000Z", affectedOrderCount: 10, orderCodes: ["O1"] }],
  followupEvents: [{ eventType: "PUSH_REQUESTED", eventTime: "2026-09-10T01:00:00.000Z", oldState: "FIRST_PUSH_SENT", newState: "SECOND_PUSH_PENDING" }],
  suppressionEvidence: [], actions: [{ actionId: "a1", actionType: "FIRST_PUSH", createdAt: "2026-09-10T00:45:00.000Z", dispatchStatus: "SENT", confirmedAt: "2026-09-10T00:46:00.000Z", messageId: "m1", batchId: null, caseMembershipProven: true, caseConfirmation: "CONFIRMED" }], resolvedAt: null, closedAt: null,
  ...overrides,
});

describe("Adaptive V2 retained-evidence normalizer", () => {
  it("1. prevents future-event leakage", () => {
    const snap = snapshotCaseAt(record({ incidentHistory: [...record().incidentHistory, { recordedAt: "2026-09-10T03:00:00.000Z", affectedOrderCount: 0, orderCodes: [] }] }), observedAt);
    expect(snap.backlog.currentAffectedOrders).toBe(10);
  });
  it("2. preserves historical state unavailable", () => expect(snapshotCaseAt(record({ historicalState: "HISTORICAL_STATE_UNAVAILABLE", incidentHistory: [] }), observedAt).evidenceQuality.quality).toBe("HISTORICAL_STATE_UNAVAILABLE"));
  it("3. normalizes active structured commitment", () => expect(snapshotCaseAt(record(), observedAt, { commitment: { recordedAt: "2026-09-10T01:00:00.000Z", committedCompletionAt: "2026-09-10T03:00:00.000Z", actor: "lead", source: "STRUCTURED", }, slaDeadlineAt: "2026-09-10T06:00:00.000Z", deliveryInProgress: false }).operatorResponse.status).toBe("ACTIVE_COMMITMENT"));
  it("4. normalizes expired commitment", () => expect(snapshotCaseAt(record(), observedAt, { commitment: { recordedAt: "2026-09-10T01:00:00.000Z", committedCompletionAt: "2026-09-10T01:30:00.000Z", actor: "lead", source: "STRUCTURED" } }).operatorResponse.status).toBe("EXPIRED_COMMITMENT"));
  it("5. keeps commitment recorded after observation unknown", () => expect(snapshotCaseAt(record(), observedAt, { commitment: { recordedAt: "2026-09-10T03:00:00.000Z", committedCompletionAt: "2026-09-10T04:00:00.000Z", actor: "lead", source: "STRUCTURED" } }).operatorResponse.status).toBe("UNKNOWN"));
  it("6. accepts a trusted ETA into V2 input", () => {
    const snap = snapshotCaseAt(record(), observedAt, { eta: { recordedAt: "2026-09-10T01:00:00.000Z", etaAt: "2026-09-10T03:00:00.000Z", source: "ROUTE", evidenceLevel: "A_TRUSTED_OPERATIONAL" }, slaDeadlineAt: "2026-09-10T06:00:00.000Z", deliveryInProgress: true });
    expect(snapshotToV2State(snap).deliveryEtaAt).toBe("2026-09-10T03:00:00.000Z");
  });
  it("7. weak ETA cannot suppress high-risk action", () => {
    const snap = snapshotCaseAt(record(), observedAt, { eta: { recordedAt: "2026-09-10T01:00:00.000Z", etaAt: "2026-09-10T03:00:00.000Z", source: "CHAT", evidenceLevel: "D_UNSTRUCTURED" }, slaDeadlineAt: "2026-09-10T02:20:00.000Z", deliveryInProgress: true, driverAssigned: false });
    expect(evaluateV2Snapshot(snap).decision).not.toBe("WAIT");
  });
  it("8. marks missing SLA evidence explicitly", () => expect(snapshotCaseAt(record(), observedAt).evidenceQuality.missingFields).toContain("SLA_DEADLINE"));
  it("9. reconstructs V1 from dated retained state events", () => expect(reconstructV1Action(record(), observedAt).action).toBe("SECOND_PUSH"));
  it("10. uses V2 against the same normalized snapshot", () => {
    const snap = snapshotCaseAt(record(), observedAt); expect(evaluateV2Snapshot(snap).caseId).toBe(snap.identity.caseId);
  });
  it("11. identifies safe wait where resolution is observed before next check", () => {
    const rich = record({ incidentHistory: [...record().incidentHistory, { recordedAt: "2026-09-10T03:00:00.000Z", affectedOrderCount: 0, orderCodes: [] }] });
    const snap = snapshotCaseAt(rich, observedAt, { slaDeadlineAt: "2026-09-10T06:00:00.000Z", deliveryInProgress: true, eta: { recordedAt: "2026-09-10T01:00:00.000Z", etaAt: "2026-09-10T02:45:00.000Z", source: "ROUTE", evidenceLevel: "A_TRUSTED_OPERATIONAL" } });
    expect(reviewWait(rich, snap, evaluateV2Snapshot(snap)).safety).toBe("SAFE_WAIT");
  });
  it("12. identifies unsafe wait when backlog grows before next check", () => {
    const rich = record({ incidentHistory: [...record().incidentHistory, { recordedAt: "2026-09-10T03:00:00.000Z", affectedOrderCount: 12, orderCodes: ["O1"] }] });
    const snap = snapshotCaseAt(rich, observedAt, { slaDeadlineAt: "2026-09-10T06:00:00.000Z", deliveryInProgress: true, eta: { recordedAt: "2026-09-10T01:00:00.000Z", etaAt: "2026-09-10T02:45:00.000Z", source: "ROUTE", evidenceLevel: "A_TRUSTED_OPERATIONAL" } });
    expect(reviewWait(rich, snap, evaluateV2Snapshot(snap)).safety).toBe("UNSAFE_WAIT");
  });
  it("13. classifies a V1 second push with valid V2 progress wait", () => {
    const snap = snapshotCaseAt(record(), observedAt, { slaDeadlineAt: "2026-09-10T06:00:00.000Z", deliveryInProgress: true, eta: { recordedAt: "2026-09-10T01:00:00.000Z", etaAt: "2026-09-10T03:00:00.000Z", source: "ROUTE", evidenceLevel: "A_TRUSTED_OPERATIONAL" } });
    expect(classifyReplay(snap, reconstructV1Action(record(), observedAt), evaluateV2Snapshot(snap))).toBe("V2_WAITS_FOR_VALID_PROGRESS");
  });
  it("14. classifies V1 action plus unproven V2 wait as potential miss", () => {
    const snap = snapshotCaseAt(record({ incidentHistory: [{ recordedAt: "2026-09-10T00:30:00.000Z", affectedOrderCount: 10, orderCodes: [] }, { recordedAt: "2026-09-10T01:30:00.000Z", affectedOrderCount: 6, orderCodes: [] }] }), observedAt, { slaDeadlineAt: "2026-09-10T06:00:00.000Z", deliveryInProgress: false });
    expect(classifyReplay(snap, reconstructV1Action(record(), observedAt), evaluateV2Snapshot(snap))).toBe("V2_POTENTIAL_MISS");
  });
  it("15. preserves scope identity without cross-case data", () => expect(snapshotCaseAt(record({ warehouseId: "MB3", province: "HCM" }), observedAt).identity).toMatchObject({ warehouseId: "MB3", province: "HCM" }));
  it("16. has no mutation side effects", () => {
    const input = record(); const before = JSON.stringify(input); snapshotCaseAt(input, observedAt); expect(JSON.stringify(input)).toBe(before);
  });
  it("17. makes snapshots deterministic", () => expect(snapshotCaseAt(record(), observedAt)).toEqual(snapshotCaseAt(record(), observedAt)));
  it("18. makes repeated replay deterministic", () => expect(replayAdaptiveBaseline([{ record: record(), observedAt }])).toEqual(replayAdaptiveBaseline([{ record: record(), observedAt }])));
  it("19. preserves unknown V1 evidence", () => expect(reconstructV1Action(record({ followupEvents: [] }), observedAt).action).toBe("UNKNOWN"));
  it("20. uses neutral observed-outcome wording without causal claim", () => expect(replayAdaptiveBaseline([{ record: record(), observedAt }])[0].laterObservedOutcome).not.toMatch(/caused|because of intervention/i));
});
