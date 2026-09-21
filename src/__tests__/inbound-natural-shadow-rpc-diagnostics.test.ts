import { describe, expect, it } from "vitest";
import { diagnoseNaturalShadowRpcError, naturalShadowSafeFailureReason } from "@/services/inbound-natural-shadow-rpc-diagnostics";

describe("Natural Shadow RPC diagnostics", () => {
  it("preserves PostgreSQL integrity code and a safe constraint identifier", () => {
    const diagnosis = diagnoseNaturalShadowRpcError({ name: "SupabaseError", code: "23503", constraint: "inbound_evidence_sync_run_fkey", message: "sensitive order ORD-123" });
    expect(diagnosis).toMatchObject({ error_code: "23503", error_class: "SupabaseError", constraint_identifier: "inbound_evidence_sync_run_fkey", error_category: "POSTGRES_INTEGRITY_CONSTRAINT", message_category: "MESSAGE_REDACTED" });
    expect(JSON.stringify(diagnosis)).not.toContain("ORD-123");
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
