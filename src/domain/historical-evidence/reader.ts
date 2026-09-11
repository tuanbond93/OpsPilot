import type { SupabaseClient } from "@supabase/supabase-js";
import { assignmentForWarehouse } from "@/security/data-scope";

export const MAX_EVIDENCE_WINDOW_MS = 31 * 86_400_000;
export const MAX_EVIDENCE_PAGE_SIZE = 200;

export type EvidenceScope = { type: "global" } | { type: "region" | "province" | "warehouse"; id: string } | { type: "cases"; ids: string[] };
export type HistoricalEvidenceQuery = { from: string; to: string; asOf?: string; scope: EvidenceScope; limit?: number; cursor?: string | null };
export type HistoricalState = "AVAILABLE" | "HISTORICAL_STATE_UNAVAILABLE";
export type CaseConfirmation = "CONFIRMED" | "UNKNOWN";

export type HistoricalActionEvidence = {
  actionId: string; actionType: string; createdAt: string; dispatchStatus: string;
  confirmedAt: string | null; messageId: string | null; batchId: string | null;
  caseMembershipProven: boolean; caseConfirmation: CaseConfirmation;
};
export type CaseEvidenceRecord = {
  caseId: string; incidentId: string; incidentKey: string; warehouseId: string; warehouseName: string | null;
  province: string | null; region: string | null; issueType: string | null; detectedAt: string;
  historicalState: HistoricalState; incidentHistory: Array<{ recordedAt: string; affectedOrderCount: number; orderCodes: string[] }>;
  followupEvents: Array<{ eventType: string; eventTime: string; oldState: string; newState: string }>;
  suppressionEvidence: Array<{ source: string; reason: string; createdAt: string | null; expiresAt: string | null; status: "CURRENT" | "HISTORICAL" }>;
  actions: HistoricalActionEvidence[]; resolvedAt: string | null; closedAt: string | null;
};
export type EvidenceQueryResult = { records: CaseEvidenceRecord[]; nextCursor: string | null; query: HistoricalEvidenceQuery };

const timestamp = (value: string) => Date.parse(value);
export function validateHistoricalEvidenceQuery(query: HistoricalEvidenceQuery): Required<Pick<HistoricalEvidenceQuery, "limit">> & HistoricalEvidenceQuery {
  const from = timestamp(query.from); const to = timestamp(query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error("INVALID_TIME_RANGE");
  if (to - from > MAX_EVIDENCE_WINDOW_MS) throw new Error("DATE_WINDOW_TOO_LARGE");
  if (query.asOf && (!Number.isFinite(timestamp(query.asOf)) || timestamp(query.asOf) < from || timestamp(query.asOf) > to)) throw new Error("INVALID_AS_OF");
  if ((query.scope.type === "region" || query.scope.type === "province" || query.scope.type === "warehouse") && (!query.scope.id || query.scope.id.length > 120)) throw new Error("INVALID_SCOPE");
  if (query.scope.type === "cases" && (!query.scope.ids.length || query.scope.ids.length > MAX_EVIDENCE_PAGE_SIZE)) throw new Error("INVALID_CASE_SCOPE");
  const limit = Math.max(1, Math.min(Number(query.limit || 50), MAX_EVIDENCE_PAGE_SIZE));
  return { ...query, limit };
}

function inScope(incident: any, scope: EvidenceScope, allowedWarehouseIds: Set<string>) {
  if (!allowedWarehouseIds.has(String(incident.warehouse_id))) return false;
  if (scope.type === "global") return true;
  if (scope.type === "cases") return scope.ids.includes(incident.incident_key) || scope.ids.includes(incident.id);
  const assignment = assignmentForWarehouse(String(incident.warehouse_id));
  if (scope.type === "warehouse") return incident.warehouse_id === scope.id;
  return scope.type === "region" ? assignment?.zone === scope.id : assignment?.province === scope.id;
}

/** Server-side only reader. It uses select queries exclusively and returns a minimized evidence projection. */
export class HistoricalEvidenceReader {
  constructor(private readonly client: SupabaseClient, private readonly allowedWarehouseIds: string[]) {}

  async queryCases(raw: HistoricalEvidenceQuery): Promise<EvidenceQueryResult> {
    const query = validateHistoricalEvidenceQuery(raw);
    const allowed = new Set(this.allowedWarehouseIds);
    const { data: incidents, error: incidentError } = await this.client.from("incidents")
      .select("id,incident_key,warehouse_id,warehouse_name,reason_code,first_detected_at,resolved_at")
      .lte("first_detected_at", query.to).order("first_detected_at", { ascending: true }).limit(2000);
    if (incidentError) throw incidentError;
    const scoped = (incidents || []).filter((incident: any) => inScope(incident, query.scope, allowed));
    const start = query.cursor ? Math.max(0, Number(query.cursor)) : 0;
    const page = scoped.slice(start, start + query.limit);
    const incidentIds = page.map((row: any) => row.id);
    if (!incidentIds.length) return { records: [], nextCursor: null, query };
    const [casesResult, historyResult, eventResult, actionResult, auditResult, exceptionResult] = await Promise.all([
      this.client.from("followup_cases").select("id,incident_id,incident_key,current_state,first_detected_at,resolved_at,closed_at,rillnet_changed_at").in("incident_key", page.map((row: any) => row.incident_key)).limit(1000),
      this.client.from("incident_history").select("incident_id,recorded_at,affected_order_count,sample_order_codes").in("incident_id", incidentIds).gte("recorded_at", query.from).lte("recorded_at", query.to).order("recorded_at", { ascending: true }).limit(5000),
      this.client.from("followup_events").select("followup_case_id,event_type,event_time,old_state,new_state").gte("event_time", query.from).lte("event_time", query.to).order("event_time", { ascending: true }).limit(5000),
      this.client.from("notification_actions").select("id,action_type,payload,status,outcome,created_at,processed_at,provider_message_id,deduplication_key").gte("created_at", query.from).lte("created_at", query.to).limit(5000),
      this.client.from("notification_action_events").select("action_id,event_type,created_at,provider_message_id").gte("created_at", query.from).lte("created_at", query.to).limit(5000),
      this.client.from("order_exceptions").select("order_code,reason_code,created_at,expires_at,active").lte("created_at", query.to).limit(5000),
    ]);
    for (const result of [casesResult, historyResult, eventResult, actionResult, auditResult, exceptionResult]) if (result.error) throw result.error;
    const caseByKey = new Map((casesResult.data || []).map((row: any) => [row.incident_key, row]));
    const historyByIncident = new Map<string, any[]>();
    for (const row of historyResult.data || []) historyByIncident.set(row.incident_id, [...(historyByIncident.get(row.incident_id) || []), row]);
    const eventsByCase = new Map<string, any[]>();
    for (const row of eventResult.data || []) eventsByCase.set(row.followup_case_id, [...(eventsByCase.get(row.followup_case_id) || []), row]);
    const auditByAction = new Map<string, any[]>();
    for (const row of auditResult.data || []) auditByAction.set(row.action_id, [...(auditByAction.get(row.action_id) || []), row]);
    return {
      records: page.flatMap((incident: any) => {
        const followup = caseByKey.get(incident.incident_key); if (!followup) return [];
        const histories = historyByIncident.get(incident.id) || [];
        const asOfHistory = query.asOf ? histories.filter(item => timestamp(item.recorded_at) <= timestamp(query.asOf!)) : histories;
        const codes = new Set(asOfHistory.flatMap(item => Array.isArray(item.sample_order_codes) ? item.sample_order_codes : []));
        const actions = (actionResult.data || []).flatMap((action: any) => {
          const linked = String(action.payload?.incidentId || action.payload?.incident_id || "") === followup.incident_id;
          if (!linked) return [];
          const audit = auditByAction.get(action.id) || [];
          const success = audit.find(item => item.event_type === "DELIVERY_SUCCEEDED");
          const confirmed = Boolean((action.outcome === "DELIVERED" && action.provider_message_id) || success?.provider_message_id);
          return [{ actionId: action.id, actionType: action.action_type, createdAt: action.created_at, dispatchStatus: action.status,
            confirmedAt: confirmed ? success?.created_at || action.processed_at || null : null, messageId: success?.provider_message_id || action.provider_message_id || null,
            batchId: action.deduplication_key || null, caseMembershipProven: true, caseConfirmation: confirmed ? "CONFIRMED" : "UNKNOWN" } satisfies HistoricalActionEvidence];
        });
        const assignment = assignmentForWarehouse(String(incident.warehouse_id));
        const suppressionEvidence = (exceptionResult.data || []).filter((exception: any) => codes.has(exception.order_code)).map((exception: any) => ({
          source: "ORDER_EXCEPTION", reason: exception.reason_code, createdAt: exception.created_at, expiresAt: exception.expires_at,
          status: exception.active !== false && (!exception.expires_at || timestamp(exception.expires_at) > timestamp(query.asOf || query.to)) ? "CURRENT" as const : "HISTORICAL" as const,
        }));
        if (followup.current_state === "RILLNET_CHANGE_PAUSED" && (!query.asOf || timestamp(followup.rillnet_changed_at || "") <= timestamp(query.asOf))) suppressionEvidence.push({ source: "RILLNET_CHANGE_PAUSED", reason: "RILLNET_STATUS_CHANGED", createdAt: followup.rillnet_changed_at, expiresAt: null, status: "CURRENT" });
        return [{ caseId: followup.id, incidentId: followup.incident_id, incidentKey: incident.incident_key, warehouseId: incident.warehouse_id,
          warehouseName: incident.warehouse_name, province: assignment?.province || null, region: assignment?.zone || null, issueType: incident.reason_code,
          detectedAt: followup.first_detected_at || incident.first_detected_at,
          historicalState: query.asOf && !asOfHistory.length ? "HISTORICAL_STATE_UNAVAILABLE" : "AVAILABLE",
          incidentHistory: histories.sort((a, b) => timestamp(a.recorded_at) - timestamp(b.recorded_at)).map(item => ({ recordedAt: item.recorded_at, affectedOrderCount: item.affected_order_count, orderCodes: Array.isArray(item.sample_order_codes) ? item.sample_order_codes : [] })),
          followupEvents: (eventsByCase.get(followup.id) || []).sort((a, b) => timestamp(a.event_time) - timestamp(b.event_time)).map(item => ({ eventType: item.event_type, eventTime: item.event_time, oldState: item.old_state, newState: item.new_state })),
          suppressionEvidence, actions, resolvedAt: followup.resolved_at, closedAt: followup.closed_at,
        } satisfies CaseEvidenceRecord];
      }),
      nextCursor: start + query.limit < scoped.length ? String(start + query.limit) : null, query,
    };
  }
}
