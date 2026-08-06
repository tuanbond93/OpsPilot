import { NextResponse, type NextRequest } from "next/server";
import { RillnetConnector } from "@/connectors/rillnet";
import { aggregateIncidents } from "@/engine/incident";
import { RootCauseAgent } from "@/agents/root-cause";
import {
  createAdminClient,
  
} from "@/connectors/supabase";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ incidentId: string }> }
) {
  const { incidentId } = await params;

  let targetIncident = null;
  let historyRows: any[] = [];

  // Strategy 1: Fetch from Supabase DB
  try {
    const dbClient = createAdminClient();
    const incidentRepo = RepositoryFactory.getIncidentRepository(dbClient);
    const historyRepo = RepositoryFactory.getIncidentHistoryRepository(dbClient);

    const dbInc = await incidentRepo.getIncidentById(incidentId);
    if (dbInc) {
      targetIncident = {
        incidentId: dbInc.id,
        incidentKey: dbInc.incident_key,
        warehouseId: dbInc.warehouse_id,
        warehouseName: dbInc.warehouse_name || "Kho chưa xác định",
        reasonCode: dbInc.reason_code as any,
        reasonName: dbInc.reason_name,
        status: dbInc.status as any,
        priorityScore: dbInc.priority_score,
        firstDetectedAt: dbInc.first_detected_at,
        lastDetectedAt: dbInc.last_detected_at,
        affectedOrderCount: 0,
        sampleOrderCodes: [],
        averageAgeHours: null,
        maximumAgeHours: null,
        oldestOrderCode: null,
      };

      historyRows = await historyRepo.getIncidentHistory(dbInc.id);
    }
  } catch {
    // Fallback
  }

  // Strategy 2: In-memory live calculation fallback
  if (!targetIncident) {
    try {
      const connector = new RillnetConnector();
      const snapshotResult = await connector.fetchSnapshot();
      const incidents = aggregateIncidents(snapshotResult.orders);
      targetIncident = incidents.find(
        (inc) => inc.incidentId === incidentId || inc.incidentKey === incidentId
      );
    } catch {
      // Fallback
    }
  }

  if (!targetIncident) {
    return NextResponse.json(
      { error: "NotFound", message: `Incident '${incidentId}' not found.` },
      { status: 404 }
    );
  }

  try {
    const agent = new RootCauseAgent();
    const result = await agent.analyzeIncident(targetIncident, historyRows);

    return NextResponse.json({
      incident: {
        incidentId: targetIncident.incidentId,
        incidentKey: targetIncident.incidentKey,
        warehouseName: targetIncident.warehouseName,
        reasonCode: targetIncident.reasonCode,
        reasonName: targetIncident.reasonName,
        affectedOrderCount: targetIncident.affectedOrderCount,
      },
      context: {
        historyPointCount: result.context.historyPointCount,
        currentAffectedCount: result.context.currentAffectedCount,
        previousAffectedCount: result.context.previousAffectedCount,
        changeAbsolute: result.context.changeAbsolute,
        changePercent: result.context.changePercent,
        trendDirection: result.context.trendDirection,
        incidentDurationHours: result.context.incidentDurationHours,
      },
      evidence: result.evidence,
      analysis: result.analysis,
      metadata: result.metadata,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        incident: targetIncident,
        error: "RootCauseAnalysisFailed",
        message,
      },
      { status: 500 }
    );
  }
}
