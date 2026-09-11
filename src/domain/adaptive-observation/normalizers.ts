import type { CommitmentState, EmployeeResponse, EtaLevel, EvidenceConfidence, ProgressState, SlaState } from "./contracts";

const time = (value: string | null | undefined) => Date.parse(value ?? "");
export function normalizeSlaEvidence(input?: Array<{ requiredBy: string | null; source: string; evidenceLevel: string }>): { state: SlaState; requiredBy: string | null; source: string | null; evidenceLevel: string | null; confidence: EvidenceConfidence } {
  const valid = (input ?? []).filter(item => Number.isFinite(time(item.requiredBy)));
  const values = [...new Set(valid.map(item => item.requiredBy!))];
  if (!valid.length) return { state: "UNKNOWN", requiredBy: null, source: null, evidenceLevel: null, confidence: "UNKNOWN" };
  if (values.length > 1) return { state: "AMBIGUOUS", requiredBy: null, source: null, evidenceLevel: null, confidence: "LOW" };
  return { state: "KNOWN", requiredBy: values[0], source: valid[0].source, evidenceLevel: valid[0].evidenceLevel, confidence: "HIGH" };
}
export function normalizeEtaEvidence(input: { eta: string | null; source: string; evidenceLevel: EtaLevel } | null | undefined, observedAt: string): { eta: string | null; source: string | null; evidenceLevel: EtaLevel; confidence: EvidenceConfidence; expired: boolean | null } {
  if (!input || !Number.isFinite(time(input.eta))) return { eta: null, source: null, evidenceLevel: "UNKNOWN", confidence: "UNKNOWN", expired: null };
  const expired = time(input.eta) <= time(observedAt); const confidence: EvidenceConfidence = input.evidenceLevel === "TRUSTED_OPERATIONAL" ? "HIGH" : input.evidenceLevel === "STRUCTURED_OPERATOR" ? "MEDIUM" : "LOW";
  return { eta: input.eta, source: input.source, evidenceLevel: input.evidenceLevel, confidence, expired };
}
export function normalizeProgressEvidence(input?: { routeAssigned?: boolean | null; driverAssigned?: boolean | null; deliveryStarted?: boolean | null; deliveryAttempted?: boolean | null; failed?: boolean | null; completed?: boolean | null } | null): ProgressState {
  if (!input) return "UNKNOWN"; if (input.completed) return "COMPLETED"; if (input.failed) return "FAILED"; if (input.deliveryAttempted) return "DELIVERY_ATTEMPTED"; if (input.deliveryStarted) return "IN_PROGRESS"; if (input.driverAssigned) return "DRIVER_ASSIGNED"; if (input.routeAssigned) return "ROUTE_ASSIGNED"; return "NO_PROGRESS";
}
export function normalizeCommitmentEvidence(input: Array<{ actor: string | null; committedAt: string | null; committedCompletionAt: string | null; source: string; completed?: boolean }> | undefined, observedAt: string): { state: CommitmentState; actor: string | null; committedAt: string | null; committedCompletionAt: string | null; source: string | null; confidence: EvidenceConfidence } {
  if (!input) return { state: "UNKNOWN", actor: null, committedAt: null, committedCompletionAt: null, source: null, confidence: "UNKNOWN" };
  const valid = input.filter(item => item.actor && Number.isFinite(time(item.committedAt)) && Number.isFinite(time(item.committedCompletionAt)) && time(item.committedAt) <= time(observedAt));
  if (!valid.length) return { state: "NONE", actor: null, committedAt: null, committedCompletionAt: null, source: null, confidence: "HIGH" };
  const times = new Set(valid.map(item => item.committedCompletionAt)); if (times.size > 1) return { state: "AMBIGUOUS", actor: null, committedAt: null, committedCompletionAt: null, source: null, confidence: "LOW" };
  const item = valid[0]; return { state: item.completed ? "COMPLETED" : time(item.committedCompletionAt) > time(observedAt) ? "ACTIVE" : "EXPIRED", actor: item.actor, committedAt: item.committedAt, committedCompletionAt: item.committedCompletionAt, source: item.source, confidence: "HIGH" };
}
export function responseToEvidence(response: EmployeeResponse): { response: string; commitmentAt: string | null; completionAt: string | null; structuredReason: string | null } {
  if (response.type === "IN_PROGRESS") return { response: "IN_PROGRESS", commitmentAt: null, completionAt: response.expectedCompletionAt ?? null, structuredReason: null };
  if (response.type === "CANNOT_COMPLETE") return { response: "CANNOT_COMPLETE", commitmentAt: null, completionAt: null, structuredReason: response.reason };
  return { response: response.type, commitmentAt: null, completionAt: null, structuredReason: null };
}
