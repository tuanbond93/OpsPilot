import { NextResponse } from "next/server";
import { HealthRegistry } from "../../../../integrations/health";
import { StartupValidator } from "../../../../integrations/startup-validator";

export const dynamic = "force-dynamic";

export async function GET() {
  const tStart = performance.now();

  try {
    // If HealthRegistry has no checkable items registered, run Startup check to register them
    if (HealthRegistry.getCheckers().length === 0) {
      await StartupValidator.run();
    }

    const report = await HealthRegistry.checkAll();
    const durationMs = Math.round(performance.now() - tStart);

    return NextResponse.json({
      ok: report.overallStatus !== "RED",
      durationMs,
      overallStatus: report.overallStatus,
      checkedAt: report.checkedAt,
      components: report.components,
    });
  } catch (err: any) {
    const durationMs = Math.round(performance.now() - tStart);
    return NextResponse.json(
      {
        ok: false,
        durationMs,
        overallStatus: "RED",
        checkedAt: new Date().toISOString(),
        error: "HealthCheckFailed",
        message: err?.message || String(err),
      },
      { status: 500 }
    );
  }
}
