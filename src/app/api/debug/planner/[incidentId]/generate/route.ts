import { NextResponse, type NextRequest } from "next/server";
import {
  createAdminClient,
  IncidentHistoryRepository,
  ExceptionRepository,
} from "@/connectors/supabase";
import { RepositoryFactory } from "@/repositories/RepositoryFactory";
import { ActionQueue } from "@/engine/action-queue";
import { RootCauseAgent } from "@/agents/root-cause";
import { ActionPlannerAgent } from "@/agents/action-planner";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ incidentId: string }> }
) {
  const { incidentId } = await params;

  try {
    const body = await request.json().catch(() => ({}));
    const provider = body.provider || undefined;
    const model = body.model || undefined;
    const forceRegenerate = Boolean(body.forceRegenerate);
    const requestedBy = body.requestedBy ? String(body.requestedBy).trim() : undefined;

    if (forceRegenerate && (!requestedBy || requestedBy.length === 0)) {
      return NextResponse.json(
        {
          error: "MissingRequestedBy",
          message: "requestedBy is mandatory when forceRegenerate is true.",
        },
        { status: 400 }
      );
    }

    const dbClient = createAdminClient();
    const incidentRepo = RepositoryFactory.getIncidentRepository(dbClient);
    const historyRepo = new IncidentHistoryRepository(dbClient);
    const followupRepo = RepositoryFactory.getFollowupRepository(dbClient);
    const exceptionRepo = new ExceptionRepository(dbClient);
    const queue = new ActionQueue(dbClient);
    const plannerRepo = RepositoryFactory.getPlannerRepository(dbClient);

    const dbInc = await incidentRepo.getIncidentById(incidentId);
    if (!dbInc) {
      return NextResponse.json(
        { error: "NotFound", message: `Incident '${incidentId}' not found.` },
        { status: 404 }
      );
    }

    const historyRows = await historyRepo.getIncidentHistory(dbInc.id);
    const followupCase = await followupRepo.getCaseById(dbInc.id);
    const followupEvents = followupCase ? await followupRepo.getEventsByCaseId(followupCase.id) : [];
    const activeExceptions = await exceptionRepo.getActiveExceptions();
    const actionHistory = await queue.getAllActions();

    let rootCauseResult = null;
    try {
      const rcAgent = new RootCauseAgent();
      const rcRes = await rcAgent.analyzeIncident(
        {
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
          affectedOrderCount: historyRows[0]?.affected_order_count || 0,
          sampleOrderCodes: historyRows[0]?.sample_order_codes || [],
          averageAgeHours: historyRows[0]?.average_age_hours || null,
          maximumAgeHours: historyRows[0]?.maximum_age_hours || null,
          oldestOrderCode: historyRows[0]?.oldest_order_code || null,
        },
        historyRows
      );
      rootCauseResult = rcRes.analysis;
    } catch {
      // Fallback
    }

    const plannerAgent = new ActionPlannerAgent(plannerRepo);
    const res = await plannerAgent.analyzeIncident({
      incident: dbInc,
      historyRows,
      rootCauseResult,
      followupCase,
      followupEvents,
      actionHistory,
      activeExceptions,
      options: { provider, model, forceRegenerate, requestedBy },
    });

    return NextResponse.json({
      ok: true,
      cached: res.cached,
      runId: res.runId,
      result: res.result,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "PlannerGenerationFailed", message },
      { status: 500 }
    );
  }
}
