import { ADAPTIVE_OBSERVATION_SCHEMA_VERSION, type AdaptiveObservationSnapshot, type CheckpointCaseSnapshot, type EvidenceConfidence } from "./contracts";

export type Release1History = { recordedAt: string; affectedOrderCount: number };
export type Release1Exception = { reason: string; source: string; createdAt: string | null; expiresAt: string | null };
export type Release1Intervention = { type: string; confirmedAt: string; recipient: string | null };
export type Release1Response = { respondedAt: string; responseCode: string; structuredReason: string | null; actor: string | null; updateId: string | null };
/** Data supplied only by server-side repositories; absence is represented explicitly. */
export interface Release1CaseEvidence {
  caseId: string; incidentId: string; checkpointId: string; observedAt: string; trigger: string;
  scope: { region: string | null; province: string | null; warehouse: string | null; issueType: string | null };
  currentState: string | null; resolvedAt: string | null; detectedAt: string | null;
  history: Release1History[] | null; exceptions: Release1Exception[] | null; interventions: Release1Intervention[] | null; response: Release1Response | null | undefined;
  population: { engineMember: boolean | null; telegramStatusMember: boolean | null; dashboardMember: boolean | null };
}
const ms = (value: string | null | undefined) => Date.parse(value ?? "");
const ordered = <T extends { recordedAt: string }>(items: T[] | null) => [...(items ?? [])].filter(item => Number.isFinite(ms(item.recordedAt))).sort((a, b) => ms(a.recordedAt) - ms(b.recordedAt));
const day = (value: string) => value.slice(0, 10);

export function assembleBacklogTrend(current: number | null, previous: number | null, resolved: boolean, hasHistory: boolean): AdaptiveObservationSnapshot["backlog"]["trend"] {
  if (resolved || current === 0) return "RESOLVED";
  if (current === null) return "UNKNOWN";
  if (!hasHistory || previous === null) return "NEW";
  if (current > previous) return "INCREASED";
  if (current < previous) return "DECREASED";
  return "UNCHANGED";
}
export class AdaptiveObservationAssembler {
  assemble(input: Release1CaseEvidence): AdaptiveObservationSnapshot {
    const history = ordered(input.history); const current = history.at(-1)?.affectedOrderCount ?? null; const previous = history.length > 1 ? history.at(-2)?.affectedOrderCount ?? null : null;
    const resolved = Boolean(input.resolvedAt) || input.currentState === "RESOLVED" || input.currentState === "CLOSED" || current === 0;
    const activeException = (input.exceptions ?? []).filter(item => !item.expiresAt || ms(item.expiresAt) > ms(input.observedAt)).at(-1) ?? null;
    const expiredException = !activeException ? (input.exceptions ?? []).filter(item => item.expiresAt && ms(item.expiresAt) <= ms(input.observedAt)).at(-1) ?? null : null;
    const interventions = [...(input.interventions ?? [])].filter(item => Number.isFinite(ms(item.confirmedAt)) && ms(item.confirmedAt) <= ms(input.observedAt)).sort((a, b) => ms(a.confirmedAt) - ms(b.confirmedAt));
    const last = interventions.at(-1) ?? null; const response = input.response && ms(input.response.respondedAt) <= ms(input.observedAt) ? input.response : null;
    const missing = [
      ...(current === null ? ["BACKLOG"] : []), ...(input.exceptions === null ? ["EXCEPTION"] : []), ...(input.interventions === null ? ["INTERVENTION_HISTORY"] : []),
      "SLA", "ETA", "ROUTE", "DRIVER", "COMMITMENT",
    ];
    const age = input.detectedAt && Number.isFinite(ms(input.detectedAt)) ? Math.max(0, (ms(input.observedAt) - ms(input.detectedAt)) / 60_000) : null;
    const confidence: EvidenceConfidence = missing.length ? "LOW" : "HIGH";
    return {
      snapshotId: `checkpoint:${input.checkpointId}:case:${input.caseId}`, caseId: input.caseId, incidentId: input.incidentId, observedAt: input.observedAt, trigger: input.trigger, schemaVersion: ADAPTIVE_OBSERVATION_SCHEMA_VERSION,
      scope: input.scope, incident: { currentState: input.currentState, resolutionState: resolved ? "RESOLVED" : input.currentState ? "ACTIVE" : "UNKNOWN", resolvedAt: input.resolvedAt },
      backlog: { currentAffectedOrders: current, previousAffectedOrders: previous, trend: assembleBacklogTrend(current, previous, resolved, history.length > 1), backlogAgeMinutes: age, meaningfulProgress: current !== null && previous !== null && previous > 0 ? (previous - current) / previous >= .2 : null },
      progress: { routeAssigned: null, driverAssigned: null, deliveryStarted: null, latestOperationalEventAt: history.at(-1)?.recordedAt ?? null, progressState: "UNKNOWN" },
      sla: { state: "UNKNOWN", requiredBy: null, source: null, evidenceLevel: null, confidence: "UNKNOWN" }, eta: { eta: null, source: null, evidenceLevel: "UNKNOWN", confidence: "UNKNOWN", expired: null },
      exception: activeException ? { state: "ACTIVE", type: activeException.reason, source: activeException.source, createdAt: activeException.createdAt, expiresAt: activeException.expiresAt, confidence: "HIGH" } : expiredException ? { state: "EXPIRED", type: expiredException.reason, source: expiredException.source, createdAt: expiredException.createdAt, expiresAt: expiredException.expiresAt, confidence: "HIGH" } : input.exceptions === null ? { state: "UNKNOWN", type: null, source: null, createdAt: null, expiresAt: null, confidence: "UNKNOWN" } : { state: "NONE", type: null, source: null, createdAt: null, expiresAt: null, confidence: "HIGH" },
      commitment: { state: "UNKNOWN", actor: null, committedAt: null, committedCompletionAt: null, source: null, confidence: "UNKNOWN" },
      interventions: { lastConfirmedInterventionType: last?.type ?? null, lastConfirmedInterventionAt: last?.confirmedAt ?? null, interventionsToday: interventions.filter(item => day(item.confirmedAt) === day(input.observedAt)).length, lastRecipient: last?.recipient ?? null, operatorRespondedAfterLastIntervention: last ? Boolean(response && ms(response.respondedAt) >= ms(last.confirmedAt)) : null },
      operatorResponse: response ? { ...response, confidence: response.structuredReason ? "HIGH" : "MEDIUM" } : { respondedAt: null, responseCode: null, structuredReason: null, actor: null, updateId: null, confidence: input.response === undefined ? "UNKNOWN" : "HIGH" },
      evidenceQuality: { completeness: confidence, missingFields: missing, ambiguousFields: [], staleFields: [] },
    };
  }
  population(input: Release1CaseEvidence): CheckpointCaseSnapshot { return { checkpointId: input.checkpointId, checkpointAt: input.observedAt, caseId: input.caseId, ...input.population, region: input.scope.region, province: input.scope.province, warehouse: input.scope.warehouse, incidentState: input.currentState, affectedOrderCount: ordered(input.history).at(-1)?.affectedOrderCount ?? null, schemaVersion: ADAPTIVE_OBSERVATION_SCHEMA_VERSION }; }
}
export type ObservationQualityCounters = Record<"SNAPSHOT_ATTEMPTS" | "SNAPSHOT_SUCCEEDED" | "SNAPSHOT_FAILED" | "POPULATION_SNAPSHOT_SUCCEEDED" | "POPULATION_SNAPSHOT_FAILED" | "BACKLOG_KNOWN" | "EXCEPTION_KNOWN" | "INTERVENTION_HISTORY_KNOWN" | "OPERATOR_RESPONSE_KNOWN" | "SLA_KNOWN" | "ETA_KNOWN" | "PROGRESS_KNOWN" | "DRIVER_KNOWN" | "COMMITMENT_KNOWN", number>;
export function qualityCounters(snapshots: AdaptiveObservationSnapshot[]): ObservationQualityCounters {
  const count = (predicate: (snapshot: AdaptiveObservationSnapshot) => boolean) => snapshots.filter(predicate).length;
  return { SNAPSHOT_ATTEMPTS: snapshots.length, SNAPSHOT_SUCCEEDED: snapshots.length, SNAPSHOT_FAILED: 0, POPULATION_SNAPSHOT_SUCCEEDED: snapshots.length, POPULATION_SNAPSHOT_FAILED: 0, BACKLOG_KNOWN: count(s => s.backlog.currentAffectedOrders !== null), EXCEPTION_KNOWN: count(s => s.exception.state !== "UNKNOWN"), INTERVENTION_HISTORY_KNOWN: count(s => s.interventions.interventionsToday !== null), OPERATOR_RESPONSE_KNOWN: count(s => s.operatorResponse.respondedAt !== null), SLA_KNOWN: 0, ETA_KNOWN: 0, PROGRESS_KNOWN: 0, DRIVER_KNOWN: 0, COMMITMENT_KNOWN: 0 };
}
/** Local-only fixture/read-snapshot helper. It neither writes nor dispatches. */
export function dryRunRelease1(cases: Release1CaseEvidence[]): AdaptiveObservationSnapshot[] { const assembler = new AdaptiveObservationAssembler(); return cases.map(item => assembler.assemble(item)); }
