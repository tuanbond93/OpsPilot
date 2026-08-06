import { NextResponse, type NextRequest } from "next/server";
import {
  createAdminClient,
  IncidentHistoryRepository,
} from "@/connectors/supabase";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ incidentId: string }> }
) {
  const { incidentId } = await params;

  try {
    const dbClient = createAdminClient();
    const incidentRepo = RepositoryFactory.getIncidentRepository(dbClient);
    const historyRepo = new IncidentHistoryRepository(dbClient);

    const incidentRow = await incidentRepo.getIncidentById(incidentId);

    if (!incidentRow) {
      return NextResponse.json(
        {
          incident: {
            id: incidentId,
            incidentKey: incidentId,
            status: "not_found",
          },
          history: [],
        },
        { status: 200 }
      );
    }

    const historyRows = await historyRepo.getIncidentHistory(incidentRow.id);

    const history = historyRows.map((h) => ({
      recordedAt: h.recorded_at,
      affectedOrderCount: h.affected_order_count,
      averageAgeHours: h.average_age_hours ? Number(h.average_age_hours) : null,
      maximumAgeHours: h.maximum_age_hours ? Number(h.maximum_age_hours) : null,
      priorityScore: h.priority_score,
      sampleOrderCodes: h.sample_order_codes || [],
    }));

    return NextResponse.json({
      incident: {
        id: incidentRow.id,
        incidentKey: incidentRow.incident_key,
        warehouseId: incidentRow.warehouse_id,
        warehouseName: incidentRow.warehouse_name,
        reasonCode: incidentRow.reason_code,
        reasonName: incidentRow.reason_name,
        status: incidentRow.status,
        priorityScore: incidentRow.priority_score,
        firstDetectedAt: incidentRow.first_detected_at,
        lastDetectedAt: incidentRow.last_detected_at,
        resolvedAt: incidentRow.resolved_at || null,
      },
      history,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        incident: { id: incidentId, incidentKey: incidentId },
        history: [],
        note: "Database table empty or not configured",
        message,
      },
      { status: 200 }
    );
  }
}
