const GOVERNED_RPC_EXCEPTION_IDENTIFIERS = new Set([
  "INBOUND_EVIDENCE_V2_AUTHORITATIVE_SYNC_RUN_INVALID",
  "INBOUND_EVIDENCE_V2_AUTHORITATIVE_MANIFEST_INVALID",
  "INBOUND_EVIDENCE_V2_PROVENANCE_COUNT_MISMATCH",
  "INBOUND_EVIDENCE_V2_INVALID_PILOT_WAREHOUSE_SET",
  "EXISTING_EVIDENCE_INCONSISTENT",
  "INBOUND_EVIDENCE_V2_NATURAL_SHADOW_INCOMPLETE_BUNDLE",
  "INBOUND_EVIDENCE_V2_NATURAL_SHADOW_COUNT_MISMATCH",
]);

type ErrorFields = Record<string, unknown>;

export type NaturalShadowRpcDiagnosis = {
  provider: "supabase";
  error_class: string;
  error_code?: string;
  constraint_identifier?: string;
  function_identifier?: string;
  error_category: "RPC_VALIDATION_EXCEPTION" | "POSTGRES_INTEGRITY_CONSTRAINT" | "POSTGRES_INSUFFICIENT_PRIVILEGE" | "POSTGREST_ERROR" | "RPC_ERROR";
  message_category: "GOVERNED_RPC_EXCEPTION" | "MESSAGE_REDACTED" | "MESSAGE_UNAVAILABLE";
  detail_category: "GOVERNED_RPC_EXCEPTION" | "DETAIL_REDACTED" | "DETAIL_UNAVAILABLE";
  hint_category: "GOVERNED_RPC_EXCEPTION" | "HINT_REDACTED" | "HINT_UNAVAILABLE";
  rpc_exception_identifier?: string;
};

function fieldsOf(error: unknown): ErrorFields {
  return error !== null && typeof error === "object" ? error as ErrorFields : {};
}

function safeCode(value: unknown): string | undefined {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z0-9]{5,16}$/.test(code) ? code : undefined;
}

function safeIdentifier(value: unknown): string | undefined {
  const identifier = typeof value === "string" ? value.trim() : "";
  return /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(identifier) ? identifier : undefined;
}

function governedIdentifier(value: unknown): string | undefined {
  const identifier = typeof value === "string" ? value.trim() : "";
  return GOVERNED_RPC_EXCEPTION_IDENTIFIERS.has(identifier) ? identifier : undefined;
}

function messageCategory(value: unknown, exceptionIdentifier?: string): NaturalShadowRpcDiagnosis["message_category"] {
  if (exceptionIdentifier) return "GOVERNED_RPC_EXCEPTION";
  return typeof value === "string" && value.trim().length > 0 ? "MESSAGE_REDACTED" : "MESSAGE_UNAVAILABLE";
}

function detailCategory(value: unknown, exceptionIdentifier?: string): NaturalShadowRpcDiagnosis["detail_category"] {
  if (exceptionIdentifier) return "GOVERNED_RPC_EXCEPTION";
  return typeof value === "string" && value.trim().length > 0 ? "DETAIL_REDACTED" : "DETAIL_UNAVAILABLE";
}

function hintCategory(value: unknown, exceptionIdentifier?: string): NaturalShadowRpcDiagnosis["hint_category"] {
  if (exceptionIdentifier) return "GOVERNED_RPC_EXCEPTION";
  return typeof value === "string" && value.trim().length > 0 ? "HINT_REDACTED" : "HINT_UNAVAILABLE";
}

function classifyCode(code: string | undefined, exceptionIdentifier: string | undefined): NaturalShadowRpcDiagnosis["error_category"] {
  if (exceptionIdentifier || code === "P0001") return "RPC_VALIDATION_EXCEPTION";
  if (code === "42501") return "POSTGRES_INSUFFICIENT_PRIVILEGE";
  if (code?.startsWith("23")) return "POSTGRES_INTEGRITY_CONSTRAINT";
  if (code?.startsWith("PGRST")) return "POSTGREST_ERROR";
  return "RPC_ERROR";
}

/** Produces structured diagnostics without retaining native message, detail, hint, payload, or stack. */
export function diagnoseNaturalShadowRpcError(error: unknown): NaturalShadowRpcDiagnosis {
  const fields = fieldsOf(error);
  const message = typeof fields.message === "string" ? fields.message : error instanceof Error ? error.message : undefined;
  const detail = fields.details;
  const hint = fields.hint;
  const exceptionIdentifier = governedIdentifier(message) || governedIdentifier(detail) || governedIdentifier(hint);
  const errorCode = safeCode(fields.code);
  const errorClass = safeIdentifier(fields.name) || (error instanceof Error && safeIdentifier(error.constructor?.name)) || "SupabaseError";
  const constraintIdentifier = safeIdentifier(fields.constraint ?? fields.constraint_name);
  const functionIdentifier = safeIdentifier(fields.function ?? fields.function_name);

  return {
    provider: "supabase",
    error_class: errorClass,
    ...(errorCode ? { error_code: errorCode } : {}),
    ...(constraintIdentifier ? { constraint_identifier: constraintIdentifier } : {}),
    ...(functionIdentifier ? { function_identifier: functionIdentifier } : {}),
    error_category: classifyCode(errorCode, exceptionIdentifier),
    message_category: messageCategory(message, exceptionIdentifier),
    detail_category: detailCategory(detail, exceptionIdentifier),
    hint_category: hintCategory(hint, exceptionIdentifier),
    ...(exceptionIdentifier ? { rpc_exception_identifier: exceptionIdentifier } : {}),
  };
}

export function naturalShadowSafeFailureReason(diagnosis: NaturalShadowRpcDiagnosis): string {
  return diagnosis.rpc_exception_identifier || diagnosis.error_code || "NATURAL_SHADOW_RPC_FAILED";
}

export function unexpectedNaturalShadowRpcResultDiagnosis(): NaturalShadowRpcDiagnosis {
  return {
    provider: "supabase",
    error_class: "SupabaseRpcResult",
    error_category: "RPC_ERROR",
    message_category: "MESSAGE_UNAVAILABLE",
    detail_category: "DETAIL_UNAVAILABLE",
    hint_category: "HINT_UNAVAILABLE",
  };
}
