import { describe, expect, it } from "vitest";
import { diagnoseNaturalShadowRpcError, naturalShadowSafeFailureReason } from "@/services/inbound-natural-shadow-rpc-diagnostics";

describe("Natural Shadow RPC diagnostics", () => {
  it("extracts an allowlisted CHECK identifier from provider text without retaining it", () => {
    const constraint = "inbound_evidence_v2_natural_shadow_warehouses_pipeline_orders_check";
    const diagnosis = diagnoseNaturalShadowRpcError({ name: "SupabaseError", code: "23514", message: `new row violates check constraint \"${constraint}\" for order ORD-123`, details: "relation \"inbound_evidence_v2_natural_shadow_warehouses\"" });
    expect(diagnosis).toMatchObject({ error_code: "23514", error_class: "SupabaseError", constraint_identifier: constraint, constraint_relation: "inbound_evidence_v2_natural_shadow_warehouses", error_category: "POSTGRES_INTEGRITY_CONSTRAINT", message_category: "MESSAGE_REDACTED" });
    expect(JSON.stringify(diagnosis)).not.toContain("ORD-123");
  });

  it("rejects unknown and malicious provider identifiers", () => {
    const diagnosis = diagnoseNaturalShadowRpcError({ code: "23514", message: "violates check constraint \"drop_all_tables\"", details: "relation \"customers\"" });
    expect(diagnosis).toMatchObject({ constraint_identifier: "NOT_AVAILABLE", constraint_relation: "NOT_AVAILABLE" });
    expect(JSON.stringify(diagnosis)).not.toContain("drop_all_tables");
    expect(JSON.stringify(diagnosis)).not.toContain("customers");
  });

  it("preserves P0001 and a governed RPC exception identifier", () => {
    const diagnosis = diagnoseNaturalShadowRpcError({ code: "P0001", message: "INBOUND_EVIDENCE_V2_AUTHORITATIVE_MANIFEST_INVALID" });
    expect(diagnosis).toMatchObject({ error_code: "P0001", error_category: "RPC_VALIDATION_EXCEPTION", rpc_exception_identifier: "INBOUND_EVIDENCE_V2_AUTHORITATIVE_MANIFEST_INVALID" });
    expect(naturalShadowSafeFailureReason(diagnosis)).toBe("INBOUND_EVIDENCE_V2_AUTHORITATIVE_MANIFEST_INVALID");
  });

  it("keeps PostgREST codes without retaining arbitrary message, detail, or hint", () => {
    const diagnosis = diagnoseNaturalShadowRpcError({ code: "PGRST202", message: "customer 123", details: "order_id=44", hint: "retry customer 123" });
    expect(diagnosis).toMatchObject({ error_code: "PGRST202", error_category: "POSTGREST_ERROR", message_category: "MESSAGE_REDACTED", detail_category: "DETAIL_REDACTED", hint_category: "HINT_REDACTED" });
    expect(JSON.stringify(diagnosis)).not.toContain("customer 123");
    expect(JSON.stringify(diagnosis)).not.toContain("order_id");
  });
});
