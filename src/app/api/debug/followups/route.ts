import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";
import { authorizeApiRequest } from "@/security/api-security";
import { warehouseAllowedForIdentity } from "@/security/scope-guard";
import warehouseAssignments from "@/data/warehouse-assignments.generated.json";

type WarehouseAssignment = { warehouseId: string; warehouseName: string; zone: string };
const assignments = warehouseAssignments.warehouses as WarehouseAssignment[];
const assignmentById = new Map(assignments.map((item) => [String(item.warehouseId), item]));
const assignmentByName = new Map(assignments.map((item) => [item.warehouseName, item]));

export const dynamic = "force-dynamic";

function readableError(error: unknown) {
  const candidate = error instanceof Error
    ? error.message
    : error && typeof error === "object" && "message" in error
      ? (error as { message?: unknown }).message
      : error && typeof error === "object" && "error" in error
        ? (error as { error?: unknown }).error
        : null;
  return typeof candidate === "string" && candidate.trim() && candidate !== "[object Object]"
    ? candidate
    : "Không thể tải dữ liệu follow-up từ database. Vui lòng thử lại hoặc kiểm tra kết nối Supabase.";
}

export async function GET(request: NextRequest) {
  const auth = await authorizeApiRequest(request, "VIEW_SYSTEM");
  if (!auth.ok) return auth.response;
  try {
    let dbClient;
    try {
      dbClient = createAdminClient();
    } catch {
      // Fallback
    }

    const service = ServiceFactory.getFollowupService(dbClient);
    const result = await service.getAllCases();

    if (!auth.identity || !dbClient) return NextResponse.json(result);
    // incident_id is a foreign-key snapshot and can change when a source
    // incident is rebuilt during sync.  incident_key is the stable business
    // identity used by the follow-up state machine and must drive scope joins.
    // Do not build a huge `incident_key IN (...)` query here.  A broad result
    // set can exceed the Supabase URL limit and turn a valid dashboard into a
    // 500.  The incident table is bounded for this pilot; filter by key in
    // memory after one compact request instead.
    const { data: incidents, error: incidentError } = await dbClient
      .from("incidents")
      .select("id,incident_key,warehouse_id,warehouse_name,reason_name,reason_code");
    if (incidentError) throw incidentError;
    const allowedIncidentKeys = new Set((incidents || []).filter((item: any) => warehouseAllowedForIdentity(auth.identity, item.warehouse_id)).map((item: any) => item.incident_key));
    const incidentByKey = new Map((incidents || []).map((item: any) => [item.incident_key, item]));
    const cases = result.cases
      .filter((item) => allowedIncidentKeys.has(item.incident_key))
      // Follow-up records intentionally retain historical payloads, but the
      // live incident + warehouse directory are the source for human labels.
      // This keeps IDs such as "22296000:KHO_TON" out of the operator view.
      .map((item: any) => {
        const incident = incidentByKey.get(item.incident_key);
        const assignment = assignmentById.get(String(incident?.warehouse_id || ""))
          || assignmentByName.get(String(incident?.warehouse_name || item.warehouse_name || ""));
        return {
          ...item,
          warehouse_name: incident?.warehouse_name || assignment?.warehouseName || item.warehouse_name || item.payload?.warehouse || null,
          reason_name: incident?.reason_name || item.reason_name || item.payload?.reason || null,
          reason_code: incident?.reason_code || null,
          zone_name: assignment?.zone || null,
        };
      });
    if (!cases.length) return NextResponse.json({ ...result, totalCases: 0, cases });

    // A follow-up is actionable only when the operator can see the concrete
    // orders behind it.  The latest incident history is the evidence snapshot
    // that owns those sample order codes (not the historical follow-up
    // payload, which can be stale after a source sync).
    const incidentIds = new Set<string>(cases.map((item: any) => incidentByKey.get(item.incident_key)?.id).filter((id: unknown): id is string => typeof id === "string"));
    const sampleOrderCodesByIncident = new Map<string, string[]>();
    if (incidentIds.size) {
      const { data: histories, error: historyError } = await dbClient
        .from("incident_history")
        .select("incident_id, sample_order_codes, recorded_at")
        .order("recorded_at", { ascending: false })
        .limit(2000);
      if (historyError) {
        return NextResponse.json({ ...result, totalCases: cases.length, cases, enrichmentWarning: "ORDER_SAMPLES_UNAVAILABLE" });
      }
      for (const history of histories || []) {
        if (!incidentIds.has(history.incident_id)) continue;
        if (sampleOrderCodesByIncident.has(history.incident_id)) continue;
        const codes = Array.isArray(history.sample_order_codes)
          ? history.sample_order_codes.filter((code: unknown): code is string => typeof code === "string" && code.trim().length > 0)
          : [];
        sampleOrderCodesByIncident.set(history.incident_id, codes);
      }
    }
    const casesWithOrderCodes = cases.map((item: any) => {
      const incident = incidentByKey.get(item.incident_key);
      return {
        ...item,
        sample_order_codes: incident?.id ? sampleOrderCodesByIncident.get(incident.id) || [] : [],
      };
    });

    // Telegram replies are immutable reminder events.  Surface them beside the
    // relevant follow-up case so a manager does not have to inspect Telegram
    // itself to understand the latest explanation or support request.
    const { data: reminders, error: reminderError } = await dbClient
      .from("telegram_followup_reminders")
      .select("id, followup_case_id, group_id, telegram_message_id")
      .eq("status", "SENT");
    // Telegram is supporting evidence, not the source of truth for follow-up.
    // A missing migration or a transient Telegram-audit query must not make
    // the entire operational follow-up screen unavailable.
    if (reminderError) {
      return NextResponse.json({ ...result, totalCases: casesWithOrderCodes.length, cases: casesWithOrderCodes, enrichmentWarning: "TELEGRAM_REMINDERS_UNAVAILABLE" });
    }

    const visibleCaseIds = new Set(casesWithOrderCodes.map((item) => item.id));
    const reminderRows = ((reminders || []) as Array<{ id: string; followup_case_id: string; group_id: string; telegram_message_id: number | null }>)
      .filter((row) => visibleCaseIds.has(row.followup_case_id));
    const reminderIds = new Set(reminderRows.map((row) => row.id));
    const incidentKeys = new Set(casesWithOrderCodes.map((item) => item.incident_key).filter(Boolean));
    const [eventsResult, privateEventsResult, membersResult, allSentResult] = await Promise.all([
      reminderIds.size
        ? dbClient.from("telegram_followup_reminder_events").select("id, reminder_id, event_type, actor, metadata, occurred_at").in("event_type", ["FEEDBACK_RECEIVED", "SIGNAL_RECEIVED"]).order("occurred_at", { ascending: false }).limit(1000)
        : Promise.resolve({ data: [], error: null }),
      incidentKeys.size
        ? dbClient.from("conversation_events").select("id, incident_key, member_id, text, source_chat_type, created_at").eq("source_chat_type", "private").eq("direction", "INBOUND").order("created_at", { ascending: false }).limit(1000)
        : Promise.resolve({ data: [], error: null }),
      dbClient.from("telegram_pilot_members").select("id, display_name, username"),
      Promise.resolve({ data: reminders || [], error: null }),
    ]);
    if (eventsResult.error || privateEventsResult.error || membersResult.error || allSentResult.error) {
      return NextResponse.json({ ...result, totalCases: casesWithOrderCodes.length, cases: casesWithOrderCodes, enrichmentWarning: "TELEGRAM_RESPONSES_UNAVAILABLE" });
    }

    const memberName = new Map((membersResult.data || []).map((member: any) => [member.id, member.username ? `@${member.username}` : member.display_name || "Nhân viên Telegram"]));
    const caseByReminder = new Map(reminderRows.map((row) => [row.id, row.followup_case_id]));
    const caseIdByIncidentKey = new Map(casesWithOrderCodes.map((item) => [item.incident_key, item.id]));
    const messageCoverage = new Map<string, number>();
    for (const row of (allSentResult.data || []) as Array<{ group_id: string; telegram_message_id: number | null }>) {
      if (row.telegram_message_id === null) continue;
      const key = `${row.group_id}:${row.telegram_message_id}`;
      messageCoverage.set(key, (messageCoverage.get(key) || 0) + 1);
    }
    const reminderById = new Map(reminderRows.map((row) => [row.id, row]));
    const responsesByCase = new Map<string, any[]>();
    for (const event of (eventsResult.data || []) as Array<any>) {
      if (!reminderIds.has(event.reminder_id)) continue;
      const caseId = caseByReminder.get(event.reminder_id);
      const reminder = reminderById.get(event.reminder_id);
      if (!caseId || !reminder) continue;
      const metadata = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
      const actorId = typeof event.actor === "string" && event.actor.startsWith("telegram:") ? event.actor.slice("telegram:".length) : "";
      const response = {
        id: event.id,
        type: event.event_type === "SIGNAL_RECEIVED" ? "SIGNAL" : "FEEDBACK",
        text: typeof metadata.feedbackText === "string" ? metadata.feedbackText : null,
        signal: typeof metadata.signal === "string" ? metadata.signal : null,
        sender: memberName.get(actorId) || "Nhân viên Telegram",
        receivedAt: event.occurred_at,
        coveredCaseCount: reminder.telegram_message_id === null ? 1 : messageCoverage.get(`${reminder.group_id}:${reminder.telegram_message_id}`) || 1,
      };
      responsesByCase.set(caseId, [...(responsesByCase.get(caseId) || []), response]);
    }
    for (const event of (privateEventsResult.data || []) as Array<any>) {
      if (!event.incident_key || !incidentKeys.has(event.incident_key)) continue;
      const caseId = caseIdByIncidentKey.get(event.incident_key);
      if (!caseId) continue;
      const response = {
        id: event.id,
        type: "PRIVATE_REPLY",
        text: typeof event.text === "string" ? event.text : null,
        signal: null,
        sender: event.member_id ? memberName.get(event.member_id) || "Nhân viên Telegram" : "Nhân viên Telegram",
        receivedAt: event.created_at,
        coveredCaseCount: 1,
        source: "PRIVATE_DM",
      };
      responsesByCase.set(caseId, [...(responsesByCase.get(caseId) || []), response]);
    }
    const casesWithTelegramResponses = casesWithOrderCodes.map((item) => ({ ...item, telegramResponses: (responsesByCase.get(item.id) || []).slice(0, 5) }));
    return NextResponse.json({ ...result, totalCases: casesWithTelegramResponses.length, cases: casesWithTelegramResponses });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: "FollowupFetchFailed", message: readableError(err) },
      { status: 500 }
    );
  }
}
