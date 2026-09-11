import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { authorizeApiRequest } from "@/security/api-security";
import { resolveDataScope } from "@/security/data-scope";
import { HistoricalEvidenceReader, type EvidenceScope, validateHistoricalEvidenceQuery } from "@/domain/historical-evidence/reader";
import { logger } from "@/observability/logger";

export const dynamic = "force-dynamic";

function invalid(message: string) { return NextResponse.json({ error: message }, { status: 400 }); }
function parseScope(params: URLSearchParams): EvidenceScope | null {
  const type = params.get("scopeType") || "global";
  const id = params.get("scopeId") || "";
  if (type === "global") return { type: "global" };
  if (["region", "province", "warehouse"].includes(type) && id) return { type: type as "region" | "province" | "warehouse", id };
  const ids = params.getAll("caseId").filter(Boolean);
  return type === "cases" && ids.length ? { type: "cases", ids } : null;
}

export async function GET(request: NextRequest) {
  const auth = await authorizeApiRequest(request, "EXPORT_LEARNING_DATASET", { limit: 20, windowMs: 60_000 });
  if (!auth.ok) return auth.response;
  // Export permission is granted only to MANAGER and ADMIN; warehouse operators
  // and reviewers never enter this server-side evidence boundary.
  if (!auth.identity || !["MANAGER", "ADMIN"].includes(auth.identity.role)) return NextResponse.json({ error: "EVIDENCE_ACCESS_DENIED" }, { status: 403 });
  const params = request.nextUrl.searchParams;
  const scope = parseScope(params); if (!scope) return invalid("INVALID_SCOPE");
  try {
    const query = validateHistoricalEvidenceQuery({ from: params.get("from") || "", to: params.get("to") || "", asOf: params.get("asOf") || undefined,
      scope, limit: Number(params.get("limit") || 50), cursor: params.get("cursor") || null });
    const dataScope = resolveDataScope(auth.identity.role, auth.identity.appMetadata, auth.identity.userMetadata);
    const result = await new HistoricalEvidenceReader(createAdminClient(), dataScope.warehouseIds).queryCases(query);
    logger.info({ component: "HistoricalEvidenceEndpoint", operation: "queryCases", status: "info", message: "Historical evidence query completed.",
      metadata: { actor: auth.identity.actor, queryType: "cases", scopeType: scope.type, from: query.from, to: query.to, asOf: query.asOf || null, returned: result.records.length } });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "EVIDENCE_QUERY_FAILED";
    return invalid(["INVALID_TIME_RANGE", "DATE_WINDOW_TOO_LARGE", "INVALID_AS_OF", "INVALID_SCOPE", "INVALID_CASE_SCOPE"].includes(message) ? message : "EVIDENCE_QUERY_FAILED");
  }
}
