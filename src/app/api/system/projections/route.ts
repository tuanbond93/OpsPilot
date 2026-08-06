import { createAdminClient } from "@/connectors/supabase";

export async function GET() {
  const client = createAdminClient();
  const { data, error } = await (client as any)
    .from("projection_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(1)
    .single();
  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
  }
  return new Response(JSON.stringify({ ok: true, run: data }), { status: 200, headers: { "Content-Type": "application/json" } });
}
