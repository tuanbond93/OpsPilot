import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";
import { readJsonBody, resolveActor } from "@/security/api-security";
import { authorizeDecisionScope } from "@/security/scope-guard";
import { ExecutionWorkOrderError } from "@/domain/execution-work-order";

export async function POST(request: NextRequest, { params }: { params: Promise<{ decisionId: string }> }) {
  const { decisionId } = await params; const parsed = await readJsonBody(request); if (!parsed.ok) return parsed.response;
  const scoped = await authorizeDecisionScope(request, decisionId, "MANAGE_DECISION", { limit: 30, windowMs: 60_000 }); if (!scoped.ok) return scoped.response;
  try {
    const body = parsed.body;
    if (body.targetStatus !== "IN_PROGRESS" && body.targetStatus !== "COMPLETED") throw new ExecutionWorkOrderError("VALIDATION_ERROR", "targetStatus must be IN_PROGRESS or COMPLETED.");
    const result = await ServiceFactory.getExecutionWorkOrderService(createAdminClient()).transition({ decisionId, actor: resolveActor(scoped.identity, body.actor), idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "", targetStatus: body.targetStatus });
    return NextResponse.json({ ok: true, data: result.workOrder, idempotent: result.idempotent });
  } catch (error) {
    const code = error instanceof ExecutionWorkOrderError ? error.code : "WORK_ORDER_OPERATION_FAILED";
    return NextResponse.json({ error: code, message: error instanceof Error ? error.message : String(error) }, { status: code === "NOT_FOUND" ? 404 : 400 });
  }
}
