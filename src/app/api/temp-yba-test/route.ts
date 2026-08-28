import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const client = createAdminClient();
  const { data: managers } = await client.from("telegram_pilot_members").select("*").eq("role", "MANAGER");
  if (!managers || managers.length === 0) return NextResponse.json({ error: "No managers found" });
  
  const manager = managers[0];
  const { data: scopes } = await client.from("telegram_user_scopes").select("*").eq("member_id", manager.id);
  
  return NextResponse.json({ manager, scopes });
}
