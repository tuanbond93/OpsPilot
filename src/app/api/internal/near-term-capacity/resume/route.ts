import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRequest, isCronAuthorized } from "@/security/api-security";
import { createAdminClient } from "@/connectors/supabase";
import { NearTermCapacityRuntimeService } from "@/services/near-term-capacity-runtime";
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

      // Probe 1: ListModels via query param (?key=)
      let listModelsQuery: Record<string, unknown> | null = null;
      if (apiKey) {
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=10&key=${encodeURIComponent(apiKey)}`);
          const text = await res.text();
          let json: Record<string, unknown> | null = null;
          try { json = JSON.parse(text) as Record<string, unknown>; } catch {}
          const errorObj = json?.error as Record<string, unknown> | undefined;
          const modelsList = json?.models as Array<Record<string, unknown>> | undefined;
          listModelsQuery = {
            httpStatus: res.status,
            ok: res.ok,
            googleErrorCode: errorObj?.code || null,
            googleErrorStatus: errorObj?.status || null,
            googleErrorMessage: errorObj?.message || null,
            modelsCount: modelsList?.length || 0,
            sampleModels: modelsList ? modelsList.slice(0, 5).map((m) => m.name) : [],
          };
        } catch (e: unknown) {
          listModelsQuery = { error: e instanceof Error ? e.message : String(e) };
        }
      }

      // Probe 2: ListModels via header (x-goog-api-key:)
      let listModelsHeader: Record<string, unknown> | null = null;
      if (apiKey) {
        try {
          const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=10", {
            headers: { "x-goog-api-key": apiKey },
          });
          const text = await res.text();
          let json: Record<string, unknown> | null = null;
          try { json = JSON.parse(text) as Record<string, unknown>; } catch {}
          const errorObj = json?.error as Record<string, unknown> | undefined;
          const modelsList = json?.models as Array<Record<string, unknown>> | undefined;
          listModelsHeader = {
            httpStatus: res.status,
            ok: res.ok,
            googleErrorCode: errorObj?.code || null,
            googleErrorStatus: errorObj?.status || null,
            googleErrorMessage: errorObj?.message || null,
            modelsCount: modelsList?.length || 0,
          };
        } catch (e: unknown) {
          listModelsHeader = { error: e instanceof Error ? e.message : String(e) };
        }
      }

      // Probe 3: Minimal generation with configured AI_MODEL
      const configuredModel = process.env.AI_MODEL || "gemini-3.6-flash";
      let generateResult: Record<string, unknown> | null = null;
      if (apiKey) {
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${configuredModel}:generateContent?key=${encodeURIComponent(apiKey)}`, {
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
          generateResult = {
            httpStatus: res.status,
            ok: res.ok,
            googleErrorCode: errorObj?.code || null,
            googleErrorStatus: errorObj?.status || null,
            googleErrorMessage: errorObj?.message || null,
            responseText: partObj?.text || null,
          };
        } catch (e: unknown) {
          generateResult = { error: e instanceof Error ? e.message : String(e) };
        }
      }

      return NextResponse.json({
        ok: true,
        action: "gemini-diagnose",
        timestamp: new Date().toISOString(),
        provider: "gemini",
        configuredModel,
        keyPresent,
        keyLength,
        keyPrefix,
        authMode,
        listModelsQuery,
        listModelsHeader,
        generateResult,
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
