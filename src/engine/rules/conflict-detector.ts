/**
 * Detects mutually exclusive, explicitly proposed operational actions.  It is
 * deliberately conservative: absent, malformed, or merely repeated actions
 * never promote an incident into the decision lane.
 */
export type ConflictCandidate = { action?: unknown; polarity?: unknown };
export type ApprovedDirectiveCandidate = ConflictCandidate & {
  id: string;
  policyVersion: string;
  reasonCode: string;
  followupState: string | null;
  warehouseId: string | null;
  zoneName: string | null;
  actionCode: string;
  priority: number;
};

export function selectApplicablePlaybookDirectives(
  directives: readonly ApprovedDirectiveCandidate[],
  context: { reasonCode: string; followupState: string | null | undefined; warehouseId: string; zoneName: string | null }
): ApprovedDirectiveCandidate[] {
  const followupState = context.followupState || "NEW";
  return directives.filter((directive) =>
    directive.reasonCode === context.reasonCode &&
    (directive.followupState === null || directive.followupState === followupState) &&
    (directive.warehouseId === null || directive.warehouseId === context.warehouseId) &&
    (directive.zoneName === null || directive.zoneName === context.zoneName)
  );
}

export function hasConflictingActions(candidates: unknown): boolean {
  if (!Array.isArray(candidates) || candidates.length < 2) return false;
  const polarities = new Map<string, Set<string>>();
  for (const candidate of candidates as ConflictCandidate[]) {
    if (!candidate || typeof candidate !== "object") continue;
    const action = typeof candidate.action === "string" ? candidate.action.trim().toUpperCase() : "";
    const polarity = typeof candidate.polarity === "string" ? candidate.polarity.trim().toUpperCase() : "";
    if (!action || !["DO", "DONT"].includes(polarity)) continue;
    const values = polarities.get(action) || new Set<string>();
    values.add(polarity);
    polarities.set(action, values);
  }
  return [...polarities.values()].some((values) => values.has("DO") && values.has("DONT"));
}
