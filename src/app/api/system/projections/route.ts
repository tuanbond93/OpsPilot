import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";

export async function GET() {
  try {
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
