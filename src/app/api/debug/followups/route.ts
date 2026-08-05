import { NextResponse } from "next/server";
import { RillnetConnector } from "@/connectors/rillnet";
import { aggregateIncidents } from "@/engine/incident";
import { FollowupEngine } from "@/engine/followup";
import { createAdminClient, FollowupRepository } from "@/connectors/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const dbClient = createAdminClient();
    const repo = new FollowupRepository(dbClient);
    const cases = await repo.getAllCases();

    if (cases.length > 0) {
      return NextResponse.json({
        totalCases: cases.length,
        cases,
      });
    }
  } catch {
    // Fallback if DB tables not migrated yet
  }

  // Fallback in-memory state engine run
  try {
    const connector = new RillnetConnector();
    const snapshotResult = await connector.fetchSnapshot();
    const incidents = aggregateIncidents(snapshotResult.orders);

    const engine = new FollowupEngine(null, null);
    const results = await engine.processIncidentFollowups(incidents);

    return NextResponse.json({
      totalCases: results.length,
      cases: results.map((r) => ({
        incident_id: r.incidentId,
        warehouse_name: r.warehouseName,
        reason_name: r.reasonName,
        current_state: r.newState,
        current_progress_percent: r.progressPercent,
        current_assessment: r.assessment,
        payload: r.payload,
      })),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "FollowupFetchFailed", message },
      { status: 500 }
    );
  }
}
