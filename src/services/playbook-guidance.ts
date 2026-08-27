import { createAdminClient } from "@/connectors/supabase";

export type ApprovedPlaybookGuidance = { orderCodes: string[]; triggerDescription: string; responsibleOwner: string; rootCause: string; standardAction: string; evidence: string; approvedAt: string };

// Only records with the latest immutable review event APPROVED are returned.
// This is guidance for AI planning; deterministic playbook matching remains code-and-test controlled.
export async function readApprovedPlaybookGuidance(incidentId: string): Promise<ApprovedPlaybookGuidance[]> {
  const db = createAdminClient();
  const { data, error } = await db.from("playbook_gap_proposals").select("order_codes, trigger_description, responsible_owner, root_cause, standard_action, evidence, playbook_gap_proposal_reviews(event_type, occurred_at)").eq("incident_id", incidentId);
  if (error) throw error;
  return (data || []).flatMap((row: any) => {
    const latest = [...(row.playbook_gap_proposal_reviews || [])].sort((a: any, b: any) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())[0];
    if (latest?.event_type !== "APPROVED") return [];
    return [{ orderCodes: Array.isArray(row.order_codes) ? row.order_codes.filter((code: unknown): code is string => typeof code === "string") : [], triggerDescription: row.trigger_description, responsibleOwner: row.responsible_owner, rootCause: row.root_cause, standardAction: row.standard_action, evidence: row.evidence, approvedAt: latest.occurred_at }];
  });
}
