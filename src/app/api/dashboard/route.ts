import { NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { isFallbackAllowed } from "@/connectors/supabase/fallback-policy";
import { ServiceFactory } from "@/services/ServiceFactory";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // Parse Warehouse Scope (default: "all")
  const url = new URL(request.url);
  const scopeParam = url.searchParams.get("scope") || url.searchParams.get("warehouse") || "all";
  const configuredScope = scopeParam.trim();

  // Check Write Controls Governance
  const writeControlsEnabled =
    process.env.ENABLE_DASHBOARD_WRITE_CONTROLS === "true" ||
    process.env.NODE_ENV !== "production";

  let dbClient: any = null;
  try {
    dbClient = createAdminClient();
  } catch (err: unknown) {
    if (!isFallbackAllowed()) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        {
          ok: false,
          error: "DatabaseConnectionFailed",
          message: `Database client initialization failed: ${msg}`,
          dataFreshness: "stale_error",
          source: "degraded_error",
          health: {
            database: {
              status: "red",
              healthReason: `Client init error: ${msg}`,
              lastSuccessAt: null,
              lastFailureAt: nowIso,
              freshnessSeconds: null,
            },
          },
        },
        { status: 503 }
      );
    }
  }

  try {
    const dashboardService = ServiceFactory.getDashboardService(dbClient);
    
    const context = {
      scope: configuredScope,
      writeControlsEnabled,
      nowIso,
      nowMs: now
    };

    const dashboardResult = await dashboardService.getDashboard(context);
    
    return NextResponse.json(dashboardResult);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    return NextResponse.json(
      {
        ok: false,
        error: "DashboardQueryFailed",
        message,
        dataFreshness: "stale_error",
        source: "degraded_error",
        health: {
          database: {
            status: "red",
            healthReason: `Database query failed: ${message}`,
            lastSuccessAt: null,
            lastFailureAt: nowIso,
            freshnessSeconds: null,
          },
        },
        diagnostics: {
          timings: {
            incidentsMs: 0,
            historiesMs: 0,
            followupsMs: 0,
            plannerMs: 0,
            aiJobsMs: 0,
            notificationsMs: 0,
            syncRunMs: 0,
            aggregationMs: 0,
            totalMs: 0,
          },
        },
      },
      { status: 500 }
    );
  }
}
