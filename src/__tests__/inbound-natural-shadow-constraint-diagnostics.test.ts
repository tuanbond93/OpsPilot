import { describe, expect, it } from "vitest";
import {
  buildNaturalShadowConstraintSnapshot,
  evaluateNaturalShadowChecks,
  NATURAL_SHADOW_CHECK_CONSTRAINTS,
} from "@/services/inbound-natural-shadow-constraint-diagnostics";

function snapshot() {
  return buildNaturalShadowConstraintSnapshot({
    evidence_type: "INBOUND_EVIDENCE_V2_NATURAL_SHADOW", observation_type: "NATURAL", checkpoint_at_local: "2026-09-21T14:00:00+07:00", timezone: "Asia/Ho_Chi_Minh", trigger_source: "opspilot-followup-cycle", manifest_status: "COMPLETE", expected_population_count: 3, persisted_population_count: 3, conflict_count: 0, shadow_status: "COMPLETE", expected_warehouse_count: 3, persisted_warehouse_count: 3, v2_telegram_sent: false, production_flow_changed: false,
    warehouses: ["21161000", "21158000", "21160000"].map((warehouse_id) => ({ warehouse_id, warehouse_name: "safe warehouse", backlog_orders: 0, pipeline_orders: 1, pipeline_known_kg: 1.2, pipeline_unknown_weight_orders: 0, picked_not_transferred_orders: 1, in_transfer_orders: 0, arrival_confirmed_orders: 0, eta_known_orders: 0, eta_unknown_orders: 1, arrival_within_horizon_status: "UNKNOWN", arrival_within_horizon_orders: null, pipeline_pressure: "LOW", near_term_arrival_risk: "UNKNOWN", shadow_message_generated: true, shadow_message_text: "safe generated message", routing_chat_id: "100", routing_topic_id: "10" })),
  });
}

describe("Natural Shadow CHECK diagnostics", () => {
  it("uses only the closed live CHECK allowlist", () => {
    expect(NATURAL_SHADOW_CHECK_CONSTRAINTS).toContain("ck_inbound_evidence_v2_unknown_horizon");
    expect(NATURAL_SHADOW_CHECK_CONSTRAINTS).not.toContain("arbitrary_constraint");
  });

  it("logs a safe snapshot and passes the known CHECK contract", () => {
    const value = snapshot();
    expect(value.warehouses[0]).toMatchObject({ warehouse_id: "21161000", warehouse_name_nonempty: true, shadow_message_length: 22, routing_chat_id_present: true, routing_topic_id_present: true });
    expect(JSON.stringify(value)).not.toContain("safe warehouse");
    expect(JSON.stringify(value)).not.toContain("safe generated message");
    expect(evaluateNaturalShadowChecks(value)).toEqual({ local_check_preflight: "PASS", local_failed_constraint: "NOT_AVAILABLE" });
  });

  it("matches UNKNOWN/null and identifies local CHECK failures", () => {
    const unknownZero = snapshot();
    unknownZero.warehouses[0].arrival_within_horizon_orders = 0;
    expect(evaluateNaturalShadowChecks(unknownZero)).toEqual({ local_check_preflight: "FAIL", local_failed_constraint: "ck_inbound_evidence_v2_unknown_horizon" });
    const invalidEnum = snapshot();
    invalidEnum.warehouses[0].pipeline_pressure = "BROKEN";
    expect(evaluateNaturalShadowChecks(invalidEnum).local_failed_constraint).toBe("inbound_evidence_v2_natural_shadow_warehouses_pipeline_pressure_check");
    const negative = snapshot();
    negative.warehouses[0].pipeline_orders = -1;
    expect(evaluateNaturalShadowChecks(negative).local_failed_constraint).toBe("inbound_evidence_v2_natural_shadow_warehouses_pipeline_orders_check");
    const emptyMessage = snapshot();
    emptyMessage.warehouses[0].shadow_message_length = 0;
    expect(evaluateNaturalShadowChecks(emptyMessage).local_failed_constraint).toBe("inbound_evidence_v2_natural_shadow_warehouses_shadow_message_text_check");
  });
});
