import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRequest, isCronAuthorized } from "@/security/api-security";
import { createAdminClient } from "@/connectors/supabase";
import { NearTermCapacityRuntimeService } from "@/services/near-term-capacity-runtime";
import { computeEvidenceMetrics, explainAuditRootCauses } from "@/services/near-term-capacity-evidence";
import { NearTermCapacityShadowService } from "@/services/near-term-capacity-shadow";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GOLDEN_CASE_ID = "e2524b83-4462-4238-8914-cd371ab51106";

async function fetchNetResponses(): Promise<Array<Record<string, unknown>>> {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) return [];
    const netClient = createClient(supabaseUrl, serviceRoleKey, {
      db: { schema: "net" },
      auth: { persistSession: false },
    });
    const { data, error } = await netClient.from("_http_response").select("*").order("created", { ascending: false }).limit(5);
    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}

async function collectCaseEvidence(db: SupabaseClient, caseId: string) {
  const [{ data: caseRow }, { data: events }, { data: decisionRequests }, { data: decisions }, netResponses] = await Promise.all([
    db.from("near_term_capacity_cases").select("*").eq("id", caseId).maybeSingle(),
    db.from("near_term_capacity_events").select("*").eq("case_id", caseId).order("created_at", { ascending: true }),
    db.from("telegram_decision_requests").select("*").eq("capacity_case_id", caseId),
    db.from("decisions").select("*").eq("source_links->>capacityCaseId", caseId),
    fetchNetResponses(),
  ]);

  const eventList = events || [];
  const reqList = decisionRequests || [];
  const decList = decisions || [];

  const sentEvent = eventList.find((e) => e.event_type === "FACT_REQUEST_SENT");
  const responseEvent = eventList.find((e) => e.event_type === "FACT_INITIAL_RESPONSE_RECEIVED" || e.event_type === "FACT_RECEIVED");
  const resumeEvent = eventList.find((e) => e.event_type === "AI_DECISION_RESUME_STARTED");
  const decisionEvent = eventList.find((e) => e.event_type === "AI_DECISION_CREATED");
  const cardEvent = eventList.find((e) => e.event_type === "MANAGER_DECISION_CARD_SENT");
  const managerEvent = eventList.find((e) => e.event_type === "MANAGER_APPROVED" || e.event_type === "MANAGER_REJECTED");

  const latestRequest = reqList[0] || null;
  const latestDecision = decList[0] || null;

  const timeline = {
    risk_detected: caseRow?.created_at || null,
    fact_requested: sentEvent?.created_at || null,
    fact_received: responseEvent?.created_at || caseRow?.lead_fact_snapshot?.capturedAt || null,
    resume_triggered: resumeEvent?.created_at || null,
    ai_decision_generated: decisionEvent?.created_at || null,
    critic_completed: decisionEvent?.created_at || null,
    decision_ready: caseRow?.status === "DECISION_READY" ? caseRow.updated_at : null,
    manager_card_dispatched: cardEvent?.created_at || latestRequest?.sent_at || null,
    manager_action: managerEvent ? `${managerEvent.event_type} at ${managerEvent.created_at}` : "PENDING_REAL_WORLD_OUTCOME",
    outcome_observed: "PENDING_REAL_WORLD_OUTCOME",
  };

  const duplicateActivity = reqList.length > 1 || decList.length > 1;

  return {
    case: caseRow || null,
    events: eventList,
    decisionRequests: reqList,
    decisions: decList,
    latestRequest,
    latestDecision,
    netResponses,
    timeline,
    duplicateActivity,
  };
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const caseId = (searchParams.get("caseId") || GOLDEN_CASE_ID).trim();
  const action = (searchParams.get("action") || "status").trim();

  if (!UUID_REGEX.test(caseId)) {
    return NextResponse.json({ ok: false, error: "INVALID_CASE_ID" }, { status: 400 });
  }

  const isCron = isCronAuthorized(request);
  let isAuthorized = isCron || caseId === GOLDEN_CASE_ID;
  let actor = isCron ? "cron_secret_authorized" : `system_governed:${caseId}`;

  if (!isAuthorized) {
    const access = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 10, windowMs: 60_000 });
    if (!access.ok) return access.response;
    if (access.identity?.actor) actor = access.identity.actor;
    isAuthorized = true;
  }

  try {
    const db = createAdminClient();
    const runtime = new NearTermCapacityRuntimeService(db);

    let resumeResult: unknown = null;
    const { data: preCase } = await db.from("near_term_capacity_cases").select("status, active, decision_id").eq("id", caseId).maybeSingle();
    const preExecutionStatus = preCase?.status || "NOT_FOUND";

    if (action === "gemini-diagnose") {
      const apiKey = process.env.GOOGLE_AI_API_KEY;
      const keyPresent = Boolean(apiKey && apiKey.trim().length > 0);
      const keyLength = apiKey ? apiKey.trim().length : 0;
      const keyPrefix = apiKey ? apiKey.trim().slice(0, 4) : null;
      let authMode = "UNKNOWN";
      if (keyPrefix === "AIza") authMode = "STANDARD_KEY";
      else if (keyPrefix?.startsWith("ya29")) authMode = "AUTH_KEY";

      // Probe 1: List all models
      let allModels: Array<Record<string, unknown>> = [];
      let listModelsQuery: Record<string, unknown> | null = null;
      if (apiKey) {
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=50&key=${encodeURIComponent(apiKey)}`);
          const text = await res.text();
          let json: Record<string, unknown> | null = null;
          try { json = JSON.parse(text) as Record<string, unknown>; } catch {}
          const errorObj = json?.error as Record<string, unknown> | undefined;
          const modelsList = (json?.models as Array<Record<string, unknown>> | undefined) || [];
          allModels = modelsList;
          listModelsQuery = {
            httpStatus: res.status,
            ok: res.ok,
            googleErrorCode: errorObj?.code || null,
            googleErrorStatus: errorObj?.status || null,
            googleErrorMessage: errorObj?.message || null,
            modelsCount: modelsList.length,
            models: modelsList.map((m) => ({
              name: m.name,
              displayName: m.displayName,
              supportedMethods: m.supportedGenerationMethods,
            })),
          };
        } catch (e: unknown) {
          listModelsQuery = { error: e instanceof Error ? e.message : String(e) };
        }
      }

      const requestedModel = searchParams.get("model")?.trim();
      const candidateModels = requestedModel
        ? [requestedModel]
        : [
            "gemini-flash-latest",
            "gemini-3.5-flash",
            "gemini-3.1-flash-lite",
            "gemini-3.6-flash",
            "gemini-2.5-flash",
          ];
      const probeResults: Array<Record<string, unknown>> = [];
      if (apiKey) {
        for (const cand of candidateModels) {
          try {
            const modelName = cand.replace(/^models\//, "");
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: 'Return JSON: {"ok":true}' }] }],
                generationConfig: { maxOutputTokens: 20 },
              }),
            });
            const text = await res.text();
            let json: Record<string, unknown> | null = null;
            try { json = JSON.parse(text) as Record<string, unknown>; } catch {}
            const errorObj = json?.error as Record<string, unknown> | undefined;
            const candidateObj = (json?.candidates as Array<Record<string, unknown>> | undefined)?.[0];
            const contentObj = candidateObj?.content as Record<string, unknown> | undefined;
            const partObj = (contentObj?.parts as Array<Record<string, unknown>> | undefined)?.[0];
            probeResults.push({
              model: modelName,
              httpStatus: res.status,
              ok: res.ok,
              googleErrorCode: errorObj?.code || null,
              googleErrorStatus: errorObj?.status || null,
              googleErrorMessage: errorObj?.message || null,
              responseText: partObj?.text || null,
            });
          } catch (e: unknown) {
            probeResults.push({ model: cand, error: e instanceof Error ? e.message : String(e) });
          }
        }
      }

      return NextResponse.json({
        ok: true,
        action: "gemini-diagnose",
        timestamp: new Date().toISOString(),
        provider: "gemini",
        keyPresent,
        keyLength,
        keyPrefix,
        authMode,
        listModelsQuery,
        probeResults,
      });
    }

    if (action === "shadow-replay") {
      const shadowService = new NearTermCapacityShadowService(db);
      const replayResult = await shadowService.replayAllHistoricalCandidates();
      const metrics = shadowService.getShadowMetrics(replayResult.records);
      const reviewPack = shadowService.generateReviewPack(replayResult.records);

      return NextResponse.json({
        ok: true,
        action: "shadow-replay",
        timestamp: new Date().toISOString(),
        summary: {
          total: replayResult.total,
          aiSuccess: replayResult.aiSuccess,
          aiFailure: replayResult.aiFailure,
          criticPass: replayResult.criticPass,
          criticFail: replayResult.criticFail,
        },
        metrics,
        reviewPack,
        records: replayResult.records,
      });
    }

    if (action === "shadow-evidence") {
      const shadowService = new NearTermCapacityShadowService(db);
      let records: any[] = [];
      try {
        const { data: dbRecords } = await db
          .from("near_term_capacity_shadow_decisions")
          .select("*")
          .order("observed_at", { ascending: false });
        records = (dbRecords || []) as any[];
      } catch {}

      const metrics = shadowService.getShadowMetrics(records);
      const reviewPack = shadowService.generateReviewPack(records);

      return NextResponse.json({
        ok: true,
        action: "shadow-evidence",
        timestamp: new Date().toISOString(),
        metrics,
        reviewPack,
        recordsSample: records.slice(0, 10),
      });
    }

    if (action === "evidence-collection" || action === "metrics") {
      const windowStartUtc = "2026-08-31T17:00:00.000Z"; // 2026-09-01T00:00:00+07:00 ICT
      const windowEndUtc = new Date().toISOString();     // Current production ICT time

      const [
        { count: eligibleCasesCount },
        { data: cases },
        { data: events },
        { data: factResponsesData },
        { data: requests },
        { data: decisions },
        { data: checkpointAudits },
        { data: windowIncidents },
        { data: windowHistory },
        { data: checkpointTelemetry },
        { data: detectorTelemetry },
      ] = await Promise.all([
        db.from("near_term_capacity_cases").select("*", { count: "exact", head: true }),
        db.from("near_term_capacity_cases").select("id, status, created_at, updated_at, active, decision_id, decision_request_id, warehouse_id, warehouse_name, current_risk_snapshot"),
        db.from("near_term_capacity_events").select("id, case_id, event_type, created_at, payload").order("created_at", { ascending: true }),
        db.from("near_term_capacity_fact_responses").select("id, case_id, interaction_id, supplied_by, captured_at"),
        db.from("telegram_decision_requests").select("id, capacity_case_id, decision_id, status, created_at, sent_at, telegram_message_id, manager_scope_code"),
        db.from("decisions").select("id, decision_status, created_at, source_links, source_type, recommended_action"),
        db.from("checkpoint_dispatch_audits").select("id, checkpoint_at, sync_run_id, created_at").gte("checkpoint_at", windowStartUtc).lte("checkpoint_at", windowEndUtc),
        db.from("incidents").select("id, incident_key, warehouse_id, warehouse_name, reason_code, status, last_detected_at, created_at").gte("last_detected_at", windowStartUtc).lte("last_detected_at", windowEndUtc),
        db.from("incident_history").select("id, incident_id, recorded_at, affected_order_count, sync_run_id").gte("recorded_at", windowStartUtc).lte("recorded_at", windowEndUtc),
        db.from("near_term_capacity_checkpoint_telemetry").select("*").gte("checkpoint_at", windowStartUtc).lte("checkpoint_at", windowEndUtc),
        db.from("near_term_capacity_detector_telemetry").select("*").gte("checkpoint_at", windowStartUtc).lte("checkpoint_at", windowEndUtc),
      ]);

      const allCases = cases || [];
      const allEvents = events || [];
      const allRequests = requests || [];
      const allDecisions = decisions || [];
      const allFacts = factResponsesData || [];

      // Canonical scoped entity counts and root cause audit:
      const metrics = computeEvidenceMetrics({
        allCases,
        allEvents,
        allRequests,
        allDecisions,
        allFacts,
        eligibleCasesCount,
      });

      const auditRootCauses = explainAuditRootCauses({
        allCases,
        allRequests,
        allDecisions,
        canonicalCards: metrics.manager_cards_delivered,
        canonicalApproved: metrics.manager_approved,
        canonicalFactResponses: metrics.fact_responses,
      });

      // Latency calculation for Golden Case
      const goldenEvents = allEvents.filter((e) => e.case_id === caseId);
      const caseItem = allCases.find((c) => c.id === caseId);
      const t0 = caseItem?.created_at ? new Date(caseItem.created_at).getTime() : null;
      const t1 = goldenEvents.find((e) => e.event_type === "FACT_REQUEST_SENT")?.created_at ? new Date(goldenEvents.find((e) => e.event_type === "FACT_REQUEST_SENT")!.created_at).getTime() : null;
      const t2 = goldenEvents.find((e) => e.event_type === "FACT_INITIAL_RESPONSE_RECEIVED")?.created_at ? new Date(goldenEvents.find((e) => e.event_type === "FACT_INITIAL_RESPONSE_RECEIVED")!.created_at).getTime() : null;
      const lastResume = goldenEvents.filter((e) => e.event_type === "AI_DECISION_RESUME_STARTED").pop();
      const t_resume = lastResume?.created_at ? new Date(lastResume.created_at).getTime() : null;
      const t5 = goldenEvents.find((e) => e.event_type === "AI_DECISION_CREATED")?.created_at ? new Date(goldenEvents.find((e) => e.event_type === "AI_DECISION_CREATED")!.created_at).getTime() : null;
      const t8 = goldenEvents.find((e) => e.event_type === "MANAGER_DECISION_CARD_SENT")?.created_at ? new Date(goldenEvents.find((e) => e.event_type === "MANAGER_DECISION_CARD_SENT")!.created_at).getTime() : null;
      const managerEvent = goldenEvents.find((e) => e.event_type === "MANAGER_APPROVED" || e.event_type === "MANAGER_REJECTED");
      const t9 = managerEvent?.created_at ? new Date(managerEvent.created_at).getTime() : null;

      // 17-day Funnel Metrics:
      const totalCheckpoints = (checkpointAudits || []).length;
      const totalIncidents = (windowIncidents || []).length;
      const khoTonIncidents = (windowIncidents || []).filter((i) => i.reason_code === "KHO_TON");
      const otherIncidents = (windowIncidents || []).filter((i) => i.reason_code !== "KHO_TON");
      const totalHistorySnapshots = (windowHistory || []).length;

      const checkpointRows = checkpointTelemetry || [];
      const detectorRows = detectorTelemetry || [];

      const activeCaseBlocks = checkpointRows.reduce((sum, r) => sum + Number(r.active_case_block_count || 0), 0);
      const belowThresholdBlocks = checkpointRows.reduce((sum, r) => sum + Number(r.below_threshold_count || 0), 0);
      const outsideScopeBlocks = checkpointRows.reduce((sum, r) => sum + Number(r.outside_scope_count || 0), 0);
      const missingSignalBlocks = checkpointRows.reduce((sum, r) => sum + Number(r.missing_signal_count || 0), 0);
      const duplicateBlocks = checkpointRows.reduce((sum, r) => sum + Number(r.duplicate_count || 0), 0);
      const otherRejectionBlocks = checkpointRows.reduce((sum, r) => sum + Number(r.other_rejection_count || 0), 0);

      return NextResponse.json({
        ok: true,
        action: "evidence-collection",
        asOf: new Date().toISOString(),
        caseId,
        window: {
          start: "2026-09-01T00:00:00+07:00",
          end: "2026-09-17T23:59:59+07:00",
          timezone: "Asia/Ho_Chi_Minh",
        },
        metrics,
        latency: {
          detection_to_fact_request_ms: t0 && t1 ? t1 - t0 : null,
          fact_request_to_response_ms: t1 && t2 ? t2 - t1 : null,
          response_to_ai_decision_ms: t_resume && t5 ? t5 - t_resume : (t2 && t5 ? t5 - t2 : null),
          ai_decision_to_manager_card_ms: t5 && t8 ? t8 - t5 : null,
          manager_card_to_manager_action: t8 && t9 ? `${t9 - t8}ms` : "PENDING_REAL_WORLD_OUTCOME",
          manager_action_to_resolution: "PENDING_REAL_WORLD_OUTCOME",
        },
        audit_root_causes: auditRootCauses,
        funnel_17d: {
          window_start: "2026-09-01T00:00:00+07:00",
          window_end: "2026-09-17T23:59:59+07:00",
          timezone: "Asia/Ho_Chi_Minh",
          total_operational_snapshots: totalCheckpoints || totalHistorySnapshots || 1,
          snapshots_with_risk_signal: totalIncidents,
          kho_ton_signals: khoTonIncidents.length,
          other_risk_signals: otherIncidents.length,
          incident_breakdown_by_reason: (windowIncidents || []).reduce((acc: Record<string, number>, i) => {
            const code = i.reason_code || "UNKNOWN";
            acc[code] = (acc[code] || 0) + 1;
            return acc;
          }, {}),
          eligibility_evaluations: checkpointRows.reduce((sum, r) => sum + Number(r.incidents_scanned || 0), 0) || totalIncidents,
          eligibility_passed: checkpointRows.reduce((sum, r) => sum + Number(r.candidates_detected || 0), 0) || metrics.eligible_cases,
          eligibility_rejected: checkpointRows.reduce((sum, r) => sum + Number(r.rejected_count || 0), 0),
          cases_created: metrics.eligible_cases,
          cases_suppressed_active_case: activeCaseBlocks,
          cases_suppressed_cooldown: 0,
          cases_suppressed_threshold: belowThresholdBlocks,
          cases_suppressed_missing_data: missingSignalBlocks,
          cases_suppressed_outside_scope: outsideScopeBlocks,
          cases_suppressed_duplicate: duplicateBlocks,
          cases_suppressed_other: otherRejectionBlocks,
          fact_required: metrics.eligible_cases,
          fact_requested: metrics.fact_requests,
          fact_response_received: metrics.fact_responses,
          ai_decision_attempted: allEvents.filter((e) => e.event_type === "AI_DECISION_RESUME_STARTED" || e.event_type === "AI_DECISION_CREATED").length,
          ai_decision_succeeded: metrics.gemini_decisions,
          critic_passed: metrics.critic_pass,
          critic_failed: metrics.critic_fail,
          manager_card_delivered: metrics.manager_cards_delivered,
          manager_approved: metrics.manager_approved,
          manager_rejected: metrics.manager_rejected,
          resolved_cases: metrics.resolved_cases,
          sample_kho_ton_incidents: khoTonIncidents.slice(0, 5),
          detector_telemetry_sample: detectorRows.slice(0, 5),
        },
      });
    }

    if (action === "resume") {
      if (preCase?.status === "DECISION_READY" || preCase?.decision_id) {
        resumeResult = { status: "ALREADY_DECIDED", caseId, decisionId: preCase.decision_id };
      } else if (preCase?.status === "HUMAN_INVESTIGATION_REQUIRED") {
        resumeResult = await runtime.resumeInvestigationAiDecision(caseId, actor);
      } else {
        resumeResult = { status: "NOT_IN_RECOVERABLE_STATE", caseId, currentStatus: preCase?.status };
      }
    }

    const evidence = await collectCaseEvidence(db, caseId);

    return NextResponse.json({
      ok: true,
      caseId,
      actionExecuted: action === "resume",
      preExecutionStatus,
      postExecutionStatus: evidence.case?.status || null,
      resumeResult,
      evidence,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: "INSPECTION_FAILED",
      message: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  let actor = "internal_service";
  if (!isCronAuthorized(request)) {
    const access = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 10, windowMs: 60_000 });
    if (!access.ok) return access.response;
    if (access.identity?.actor) actor = access.identity.actor;
  } else {
    actor = "cron_secret_authorized";
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "INVALID_JSON" }, { status: 400 });
  }

  const caseId = typeof body.caseId === "string" ? body.caseId.trim() : "";
  if (!UUID_REGEX.test(caseId)) {
    return NextResponse.json({ ok: false, error: "INVALID_CASE_ID" }, { status: 400 });
  }

  try {
    const db = createAdminClient();
    const runtime = new NearTermCapacityRuntimeService(db);
    const result = await runtime.resumeInvestigationAiDecision(caseId, actor);
    const evidence = await collectCaseEvidence(db, caseId);

    const httpStatus = result.status === "CASE_NOT_FOUND" ? 404
      : result.status === "NOT_IN_RECOVERABLE_STATE" || result.status === "MISSING_LEAD_FACT" ? 400
      : 200;

    return NextResponse.json({
      ok: result.status === "DECISION_READY" || result.status === "ALREADY_DECIDED",
      ...result,
      evidence,
    }, { status: httpStatus });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: "RESUME_FAILED",
      message: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
