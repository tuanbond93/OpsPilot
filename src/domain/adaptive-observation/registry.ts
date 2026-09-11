export interface ObservationSourceRegistryEntry { signal: string; source: string | null; fieldOrEvent: string | null; expectedFreshness: string; evidenceLevel: string; availableNow: boolean; gap: string | null; }
/** Available-now means currently exposed by retained read evidence, not merely planned by a type. */
export const ADAPTIVE_OBSERVATION_SOURCE_REGISTRY: ObservationSourceRegistryEntry[] = [
  { signal: "backlog", source: "incident_history", fieldOrEvent: "affected_order_count", expectedFreshness: "per snapshot", evidenceLevel: "A", availableNow: true, gap: null },
  { signal: "SLA", source: null, fieldOrEvent: null, expectedFreshness: "per checkpoint", evidenceLevel: "UNKNOWN", availableNow: false, gap: "No retained deadline field in reader" },
  { signal: "customer appointment", source: "order_exceptions", fieldOrEvent: "reason_code/expires_at", expectedFreshness: "until expiry", evidenceLevel: "B", availableNow: true, gap: "Order membership may be sampled" },
  { signal: "ETA", source: null, fieldOrEvent: null, expectedFreshness: "per operational update", evidenceLevel: "UNKNOWN", availableNow: false, gap: "No structured ETA in reader" },
  { signal: "route", source: null, fieldOrEvent: null, expectedFreshness: "per operational update", evidenceLevel: "UNKNOWN", availableNow: false, gap: "No route source in reader" },
  { signal: "driver", source: null, fieldOrEvent: null, expectedFreshness: "per operational update", evidenceLevel: "UNKNOWN", availableNow: false, gap: "No driver source in reader" },
  { signal: "delivery progress", source: "incident_history", fieldOrEvent: "affected_order_count", expectedFreshness: "per snapshot", evidenceLevel: "B", availableNow: true, gap: "No granular delivery state" },
  { signal: "exception", source: "order_exceptions", fieldOrEvent: "created_at/expires_at", expectedFreshness: "until expiry", evidenceLevel: "A", availableNow: true, gap: null },
  { signal: "commitment", source: null, fieldOrEvent: null, expectedFreshness: "per response", evidenceLevel: "UNKNOWN", availableNow: false, gap: "No structured commitment source" },
  { signal: "confirmed intervention", source: "notification_actions + notification_action_events", fieldOrEvent: "DELIVERY_SUCCEEDED", expectedFreshness: "on dispatch", evidenceLevel: "A", availableNow: true, gap: "Grouped member link required" },
  { signal: "operator response", source: null, fieldOrEvent: null, expectedFreshness: "on response", evidenceLevel: "UNKNOWN", availableNow: false, gap: "No normalized response reader" },
  { signal: "resolution", source: "incidents/followup_cases", fieldOrEvent: "resolved_at/current state", expectedFreshness: "on resolution", evidenceLevel: "A", availableNow: true, gap: "Historic mutable state requires snapshot" },
];
