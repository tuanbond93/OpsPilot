import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";
import { authorizeApiRequest } from "@/security/api-security";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizeApiRequest(request, "VIEW_SYSTEM", { limit: 120, windowMs: 60_000 });
    if (!auth.ok) return auth.response;
    let client;
    try {
      client = createAdminClient();
    } catch {
      // Fallback
    }

    const service = ServiceFactory.getProjectionService(client);
    const data = await service.getLatestRun();

    return new Response(JSON.stringify({ ok: true, run: data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: message }), { status: 500 });
  }
}
