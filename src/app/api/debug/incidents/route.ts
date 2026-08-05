import { NextResponse } from "next/server";
import { createAdminClient, IncidentRepository } from "@/connectors/supabase";
import { RillnetConnector } from "@/connectors/rillnet";
import { aggregateIncidents } from "@/engine/incident";

export const dynamic = "force-dynamic";

export async function GET() {
  // Strategy 1: Try reading persisted open incidents from Supabase
  try {
    const dbClient = createAdminClient();
    const repo = new IncidentRepository(dbClient);
    const dbIncidents = await repo.getOpenIncidents();

    if (dbIncidents.length > 0) {
      const summaryFields = dbIncidents.map((inc) => ({
        incidentId: inc.id,
        incidentKey: inc.incident_key,
        warehouseId: inc.warehouse_id,
        warehouseName: inc.warehouse_name || "Kho chưa xác định",
        reasonCode: inc.reason_code,
        reasonName: inc.reason_name,
        affectedOrderCount: 0,
        priorityScore: inc.priority_score,
        firstDetectedAt: inc.first_detected_at,
        lastDetectedAt: inc.last_detected_at,
        averageAgeHours: null,
        maximumAgeHours: null,
        oldestOrderCode: null,
        sampleOrderCodes: [],
      }));

      return NextResponse.json({
        source: "database",
        totalIncidents: summaryFields.length,
        incidents: summaryFields,
      });
    }
  } catch {
    // Fallback to in-memory evaluation if DB is not connected/unpopulated
  }

  // Strategy 2: In-memory live calculation fallback
  try {
    const connector = new RillnetConnector();
    const snapshotResult = await connector.fetchSnapshot();
    const incidents = aggregateIncidents(snapshotResult.orders);

    const summaryFields = incidents.map((inc) => ({
      incidentId: inc.incidentId,
      incidentKey: inc.incidentKey,
      warehouseId: inc.warehouseId,
      warehouseName: inc.warehouseName,
      reasonCode: inc.reasonCode,
      reasonName: inc.reasonName,
      affectedOrderCount: inc.affectedOrderCount,
      priorityScore: inc.priorityScore,
      firstDetectedAt: inc.firstDetectedAt,
      lastDetectedAt: inc.lastDetectedAt,
      averageAgeHours: inc.averageAgeHours,
      maximumAgeHours: inc.maximumAgeHours,
      oldestOrderCode: inc.oldestOrderCode,
      sampleOrderCodes: inc.sampleOrderCodes,
    }));

    return NextResponse.json({
      source: "live_snapshot",
      totalIncidents: summaryFields.length,
      incidents: summaryFields,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "RuleEngineError", message },
      { status: 500 }
    );
  }
}
