import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import {
  buildRootCauseLearningDataset,
  serializeLearningDatasetJsonl,
  type LearningCauseCode,
  type LearningCopilotReview,
  type LearningCopilotRun,
  type LearningVerification,
} from "@/evaluation/rootCauseLearningDataset";
import { authorizeApiRequest } from "@/security/api-security";

export const dynamic = "force-dynamic";
type IncidentRelation = { warehouse_name: string | null; reason_name: string | null };
function incidentContext(value: IncidentRelation | IncidentRelation[] | null) {
  return Array.isArray(value) ? value[0] : value;
}

export async function GET(request: NextRequest) {
  try {
    if (request.nextUrl.searchParams.get("format") === "jsonl") {
      const auth = await authorizeApiRequest(request, "EXPORT_LEARNING_DATASET", { limit: 10, windowMs: 60_000 });
      if (!auth.ok) return auth.response;
    }
    const db = createAdminClient();
    const [verificationResult, runResult, reviewResult] = await Promise.all([
      db.from("incident_verifications").select("id,incident_id,actual_cause,evidence,notes,verified_by,verified_at,incidents(warehouse_name,reason_name)").order("verified_at", { ascending: false }).limit(2000),
      db.from("copilot_runs").select("id,incident_id,prompt_id,prompt_version,provider,model,copilot_result,created_at").order("created_at", { ascending: false }).limit(2000),
      db.from("copilot_reviews").select("run_id,status,edited_result,reviewed_by,rating,comment,reviewed_at").eq("is_active", true).limit(2000),
    ]);
    const failed = [verificationResult, runResult, reviewResult].find((result) => result.error);
    if (failed?.error) return NextResponse.json({ error: "LEARNING_DATASET_QUERY_FAILED", message: failed.error.message }, { status: 500 });

    const dataset = buildRootCauseLearningDataset({
      verifications: (verificationResult.data || []).map((row) => {
        const incident = incidentContext(row.incidents as IncidentRelation | IncidentRelation[] | null);
        return {
          id: row.id,
          incidentId: row.incident_id,
          actualCause: row.actual_cause as LearningCauseCode,
          evidence: row.evidence,
          notes: row.notes,
          verifiedBy: row.verified_by,
          verifiedAt: row.verified_at,
          warehouseName: incident?.warehouse_name || "Kho chưa xác định",
          incidentType: incident?.reason_name || "Loại sự cố chưa xác định",
        };
      }) as LearningVerification[],
      runs: (runResult.data || []).map((row) => ({ id: row.id, incidentId: row.incident_id, promptId: row.prompt_id, promptVersion: row.prompt_version, provider: row.provider, model: row.model, result: row.copilot_result || {}, createdAt: row.created_at })) as LearningCopilotRun[],
      reviews: (reviewResult.data || []).map((row) => ({ runId: row.run_id, status: row.status, editedResult: row.edited_result, reviewedBy: row.reviewed_by, rating: row.rating, comment: row.comment, reviewedAt: row.reviewed_at })) as LearningCopilotReview[],
    });

    if (request.nextUrl.searchParams.get("format") === "jsonl") {
      return new NextResponse(serializeLearningDatasetJsonl(dataset), {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "content-disposition": `attachment; filename="${dataset.datasetVersion}.jsonl"`,
          "cache-control": "no-store",
        },
      });
    }
    return NextResponse.json({ ok: true, dataset });
  } catch (error: unknown) {
    return NextResponse.json({ error: "LEARNING_DATASET_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
