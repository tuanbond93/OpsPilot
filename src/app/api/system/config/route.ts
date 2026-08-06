import { NextResponse } from "next/server";
import { INTEGRATIONS_CONFIG } from "../../../../config/integrations";
import { SCHEDULER_JOBS } from "../../../../config/scheduler";
import { SecretProvider } from "../../../../integrations/secrets";

export const dynamic = "force-dynamic";

function maskString(str: string, visibleLen = 4): string {
  if (!str) return "not_configured";
  if (str.length <= visibleLen) return "****";
  return str.slice(0, visibleLen) + "****" + str.slice(-visibleLen);
}

export async function GET() {
  try {
    const rawUrl = SecretProvider.getOptional("NEXT_PUBLIC_SUPABASE_URL", "");
    const maskedSupabaseUrl = maskString(rawUrl, 8);

    const rawChatId = SecretProvider.getOptional("TELEGRAM_CHAT_ID", "");
    const maskedTelegramChat = maskString(rawChatId, 3);

    const jobsSummary = SCHEDULER_JOBS.map((j) => ({
      name: j.name,
      description: j.description,
      schedule: j.schedule,
      enabled: j.enabled,
    }));

    return NextResponse.json({
      ok: true,
      environment: process.env.NODE_ENV || "development",
      aiProvider: INTEGRATIONS_CONFIG.ai.provider,
      aiModel: INTEGRATIONS_CONFIG.ai.model,
      writeControlsEnabled:
        process.env.ENABLE_DASHBOARD_WRITE_CONTROLS === "true" ||
        process.env.NODE_ENV !== "production",
      supabase: {
        url: maskedSupabaseUrl,
        anonymousKeyConfigured: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        serviceRoleConfigured: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      },
      telegram: {
        chatId: maskedTelegramChat,
        botTokenConfigured: !!process.env.TELEGRAM_BOT_TOKEN,
      },
      scheduler: {
        activeJobsCount: jobsSummary.length,
        jobs: jobsSummary,
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        error: "ConfigLoadFailed",
        message: err?.message || String(err),
      },
      { status: 500 }
    );
  }
}
