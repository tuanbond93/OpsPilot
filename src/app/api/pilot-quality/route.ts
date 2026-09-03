import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";
import {
  buildPilotQualitySnapshot,
  type PilotDecision,
  type PilotFeedback,
  type PilotOutcome,
  type PilotVerifiedOutcome,
  type PilotReview,
  type PilotVerification,
} from "@/services/pilot-quality";
import { authorizeApiRequest, isAuthEnforced } from "@/security/api-security";
import { buildMb03ReadinessSnapshot } from "@/services/telegram-mb03-readiness";

export const dynamic = "force-dynamic";

type WorkflowEventRow = { feedback_id: string; new_status: PilotFeedback["currentStatus"]; occurred_at: string };
type IncidentRelation = { warehouse_name: string | null; reason_name: string | null };

function incidentContext(value: IncidentRelation | IncidentRelation[] | null): IncidentRelation {
  if (Array.isArray(value)) return value[0] || { warehouse_name: null, reason_name: null };
  return value || { warehouse_name: null, reason_name: null };
}

export async function GET(request: NextRequest) {
  const auth = await authorizeApiRequest(request, "VIEW_SYSTEM");
  if (!auth.ok) return auth.response;
  try {
    const db = createAdminClient();
    const [verificationResult, feedbackResult, workflowResult, reviewResult, decisionResult, outcomeResult, verifiedOutcomeResult, mb03Result] =
      await Promise.all([
        db.from("incident_verifications").select("incident_id,actual_cause,verified_at,incidents(warehouse_name,reason_name)").order("verified_at", { ascending: false }).limit(1000),
        db.from("incident_feedback_reports").select("id,category,reported_at").order("reported_at", { ascending: false }).limit(1000),
        db.from("incident_feedback_workflow_events").select("feedback_id,new_status,occurred_at").order("occurred_at", { ascending: false }).limit(3000),
        db.from("copilot_reviews").select("status,rating,reviewed_at").eq("is_active", true).limit(1000),
        db.from("decisions").select("id,decision_mode,decision_status").limit(1000),
        db.from("decision_outcomes").select("decision_id,status,measured_at").limit(1000),
        db.from("decision_outcome_verifications").select("decision_id,classification,observed_at").limit(1000),
        db.from("conversation_events").select("ai_result,created_at").eq("direction", "OUTBOUND").contains("ai_result", { type: "MB03_DISCOVERY" }).order("created_at", { ascending: false }).limit(1000),
      ]);

    const failed = [verificationResult, feedbackResult, workflowResult, reviewResult, decisionResult, outcomeResult, verifiedOutcomeResult, mb03Result]
      .find((result) => result.error);
    if (failed?.error) {
      return NextResponse.json({ error: "PILOT_QUALITY_QUERY_FAILED", message: failed.error.message }, { status: 500 });
    }

    const latestWorkflow = new Map<string, WorkflowEventRow>();
    for (const event of (workflowResult.data || []) as WorkflowEventRow[]) {
      if (!latestWorkflow.has(event.feedback_id)) latestWorkflow.set(event.feedback_id, event);
    }

    const snapshot = buildPilotQualitySnapshot({
      verifications: (verificationResult.data || []).map((row) => {
        const context = incidentContext(row.incidents as IncidentRelation | IncidentRelation[] | null);
        return {
          incidentId: row.incident_id,
          actualCause: row.actual_cause,
          verifiedAt: row.verified_at,
          warehouseName: context.warehouse_name || "Kho chưa xác định",
          incidentType: context.reason_name || "Loại sự cố chưa xác định",
        };
      }) as PilotVerification[],
      feedback: (feedbackResult.data || []).map((row) => ({
        id: row.id,
        category: row.category,
        reportedAt: row.reported_at,
        currentStatus: latestWorkflow.get(row.id)?.new_status || "OPEN",
      })) as PilotFeedback[],
      reviews: (reviewResult.data || []).map((row) => ({
        status: row.status,
        rating: row.rating,
        reviewedAt: row.reviewed_at,
      })) as PilotReview[],
      decisions: (decisionResult.data || []).map((row) => ({
        id: row.id,
        mode: row.decision_mode,
        status: row.decision_status,
      })) as PilotDecision[],
      outcomes: (outcomeResult.data || []).map((row) => ({
        decisionId: row.decision_id,
        status: row.status,
        measuredAt: row.measured_at,
      })) as PilotOutcome[],
      verifiedOutcomes: (verifiedOutcomeResult.data || []).map((row) => ({
        decisionId: row.decision_id,
        classification: row.classification,
        verifiedAt: row.observed_at,
      })) as PilotVerifiedOutcome[],
      authEnforced: isAuthEnforced(),
    });

    const qualityResult = await ServiceFactory.getCopilotQualityService(db).getQualitySummary();
    return NextResponse.json({
      ok: true,
      snapshot,
      mb03: buildMb03ReadinessSnapshot(mb03Result.data || []),
      copilotQuality: qualityResult.ok ? qualityResult.summary : null,
      limitations: [
        "Các tỷ lệ chỉ phản ánh mẫu đã được con người review hoặc xác minh.",
        "Không có mẫu không đồng nghĩa chất lượng đạt 100%.",
        "Outcome chỉ là kết quả vận hành quan sát được; không tính financial saving.",
      ],
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: "PILOT_QUALITY_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
