import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRequest } from "@/security/api-security";
import { resolveDataScope, scopeResponse } from "@/security/data-scope";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await authorizeApiRequest(request, "VIEW_SYSTEM");
  if (!auth.ok) return auth.response;
  if (!auth.identity) return NextResponse.json({ mode: "ALL", employeeId: null, warehouseCount: 0, zones: [], provinces: [], pics: [], warehouses: [] });
  return NextResponse.json(scopeResponse(resolveDataScope(auth.identity.role, auth.identity.appMetadata, auth.identity.userMetadata)));
}
