import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { roleCan, roleFromMetadata } from "@/security/roles";
import CheckpointObservabilityClient from "./CheckpointObservabilityClient";

export const dynamic = "force-dynamic";

export default async function CheckpointObservabilityPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/account?next=/system/observability");

  const role = roleFromMetadata(data.user.app_metadata, data.user.user_metadata);
  if (!roleCan(role, "MANAGE_SYSTEM")) redirect("/dashboard?access=denied");

  return <CheckpointObservabilityClient />;
}
