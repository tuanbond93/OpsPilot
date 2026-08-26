import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { ServiceFactory } from "@/services/ServiceFactory";
import { readJsonBody, resolveActor } from "@/security/api-security";
import { authorizeDecisionScope } from "@/security/scope-guard";
import { ExecutionWorkOrderError } from "@/domain/execution-work-order";

function service() { return ServiceFactory.getExecutionWorkOrderService(createAdminClient()); }
function failure(error: unknown) {
  const code = error instanceof ExecutionWorkOrderError ? error.code : "WORK_ORDER_OPERATION_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: code, message }, { status: code === "NOT_FOUND" ? 404 : code === "DECISION_NOT_APPROVED" ? 409 : 400 });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ decisionId: string }> }) {
  const { decisionId } = await params;
  const scoped = await authorizeDecisionScope(request, decisionId, "VIEW_SYSTEM");
  if (!scoped.ok) return scoped.response;
  try {
    const workOrder = await service().get(decisionId);
    return workOrder ? NextResponse.json({ ok: true, data: workOrder }) : NextResponse.json({ ok: true, data: null });
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ decisionId: string }> }) {
  const { decisionId } = await params; const parsed = await readJsonBody(request); if (!parsed.ok) return parsed.response;
  const scoped = await authorizeDecisionScope(request, decisionId, "MANAGE_DECISION", { limit: 30, windowMs: 60_000 });
  if (!scoped.ok) return scoped.response;
  try {
    const body = parsed.body;
    const result = await service().create({ decisionId, actor: resolveActor(scoped.identity, body.actor), idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "", owner: typeof body.owner === "string" ? body.owner : "", dueAt: typeof body.dueAt === "string" ? body.dueAt : "", actionItems: Array.isArray(body.actionItems) ? body.actionItems : [] });
    return NextResponse.json({ ok: true, data: result.workOrder, idempotent: result.idempotent }, { status: result.idempotent ? 200 : 201 });
  } catch (error) { return failure(error); }
}
