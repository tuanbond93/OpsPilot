import type { SupabaseClient } from "@supabase/supabase-js";
import type { ITriageAuditRepository, TriageAuditInsert, TriageAuditRecord } from "../interfaces/ITriageAuditRepository";

export class SupabaseTriageAuditRepository implements ITriageAuditRepository {
  constructor(private client: SupabaseClient) {}

  async recordBatch(items: TriageAuditInsert[]): Promise<number> {
    if (!items.length) return 0;
    const { error } = await this.client.from("incident_triage_evaluations").upsert(
      items.map((item) => ({
        incident_id: item.incidentId,
        sync_run_id: item.syncRunId,
        route: item.route,
        reason_code: item.reasonCode,
        severity: item.severity,
        decision_complexity: item.decisionComplexity,
        triage_reason: item.triageReason,
        routing_version: item.routingVersion,
        evidence: item.evidence,
        created_at: new Date().toISOString(),
      })),
      { onConflict: "incident_id,sync_run_id" }
    );
    if (error) throw new Error(`Triage audit persistence failed: ${error.message}`);
    return items.length;
  }

  async getLatestByIncidentIds(incidentIds: string[]): Promise<TriageAuditRecord[]> {
    if (!incidentIds.length) return [];
    const { data, error } = await this.client
      .from("incident_triage_evaluations")
      .select("id, incident_id, sync_run_id, route, reason_code, severity, decision_complexity, triage_reason, routing_version, evidence, created_at")
      .in("incident_id", incidentIds)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Triage audit lookup failed: ${error.message}`);

    const latestByIncident = new Map<string, TriageAuditRecord>();
    for (const row of data || []) {
      if (latestByIncident.has(row.incident_id)) continue;
      latestByIncident.set(row.incident_id, {
        id: row.id,
        incidentId: row.incident_id,
        syncRunId: row.sync_run_id,
        route: row.route,
        reasonCode: row.reason_code,
        severity: row.severity,
        decisionComplexity: row.decision_complexity,
        triageReason: row.triage_reason,
        routingVersion: row.routing_version,
        evidence: row.evidence || {},
        createdAt: row.created_at,
      });
    }
    return [...latestByIncident.values()];
  }
}
