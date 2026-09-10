import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { authorizeApiRequest } from "@/security/api-security";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const access = await authorizeApiRequest(request, "VIEW_SYSTEM", { limit: 30, windowMs: 60_000 });
  if (!access.ok) return access.response;
  const { data, error } = await createAdminClient().from("checkpoint_dispatch_audits")
    .select("*").order("checkpoint_at", { ascending: false }).limit(20);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, audits: data || [] });
}
