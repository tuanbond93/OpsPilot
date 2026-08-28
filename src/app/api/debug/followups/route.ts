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

    // Telegram replies are immutable reminder events.  Surface them beside the
    // relevant follow-up case so a manager does not have to inspect Telegram
    // itself to understand the latest explanation or support request.
    const { data: reminders, error: reminderError } = await dbClient
      .from("telegram_followup_reminders")
      .select("id, followup_case_id, group_id, telegram_message_id")
      .eq("status", "SENT");
    if (reminderError) throw reminderError;

    const visibleCaseIds = new Set(cases.map((item) => item.id));
    const reminderRows = ((reminders || []) as Array<{ id: string; followup_case_id: string; group_id: string; telegram_message_id: number | null }>)
      .filter((row) => visibleCaseIds.has(row.followup_case_id));
    const reminderIds = reminderRows.map((row) => row.id);
    if (!reminderIds.length) return NextResponse.json({ ...result, totalCases: cases.length, cases });

    const [eventsResult, membersResult, allSentResult] = await Promise.all([
      dbClient.from("telegram_followup_reminder_events").select("id, reminder_id, event_type, actor, metadata, occurred_at").in("reminder_id", reminderIds).in("event_type", ["FEEDBACK_RECEIVED", "SIGNAL_RECEIVED"]).order("occurred_at", { ascending: false }),
      dbClient.from("telegram_pilot_members").select("id, display_name, username"),
      Promise.resolve({ data: reminders || [], error: null }),
    ]);
    if (eventsResult.error) throw eventsResult.error;
    if (membersResult.error) throw membersResult.error;
    if (allSentResult.error) throw allSentResult.error;

    const memberName = new Map((membersResult.data || []).map((member: any) => [member.id, member.username ? `@${member.username}` : member.display_name || "Nhân viên Telegram"]));
    const caseByReminder = new Map(reminderRows.map((row) => [row.id, row.followup_case_id]));
    const messageCoverage = new Map<string, number>();
    for (const row of (allSentResult.data || []) as Array<{ group_id: string; telegram_message_id: number | null }>) {
      if (row.telegram_message_id === null) continue;
      const key = `${row.group_id}:${row.telegram_message_id}`;
      messageCoverage.set(key, (messageCoverage.get(key) || 0) + 1);
    }
    const reminderById = new Map(reminderRows.map((row) => [row.id, row]));
    const responsesByCase = new Map<string, any[]>();
    for (const event of (eventsResult.data || []) as Array<any>) {
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
    const casesWithTelegramResponses = cases.map((item) => ({ ...item, telegramResponses: (responsesByCase.get(item.id) || []).slice(0, 5) }));
    return NextResponse.json({ ...result, totalCases: casesWithTelegramResponses.length, cases: casesWithTelegramResponses });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "FollowupFetchFailed", message },
      { status: 500 }
    );
  }
}
