import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateExecutionWorkOrderInput, ExecutionWorkOrder, ExecutionWorkOrderStatus } from "@/domain/execution-work-order";
import type { ExecutionWorkOrderMutationResult, IExecutionWorkOrderRepository } from "../interfaces/IExecutionWorkOrderRepository";

function map(row: Record<string, any>): ExecutionWorkOrder {
  return { workOrderId: row.id, decisionId: row.decision_id, workOrderCode: row.work_order_code, status: row.status,
    owner: row.owner, dueAt: row.due_at, actionItems: row.action_items || [], createdBy: row.created_by,
    createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at };
}

export class SupabaseExecutionWorkOrderRepository implements IExecutionWorkOrderRepository {
  constructor(private readonly client: SupabaseClient) {}
  async getByDecisionId(decisionId: string) {
    const { data, error } = await this.client.from("execution_work_orders").select("*").eq("decision_id", decisionId).maybeSingle();
    if (error) throw error; return data ? map(data) : null;
  }
  async create(input: CreateExecutionWorkOrderInput & { workOrderCode: string }): Promise<ExecutionWorkOrderMutationResult> {
    const existing = await this.getByDecisionId(input.decisionId);
    if (existing) return { workOrder: existing, idempotent: true };
    const { data, error } = await this.client.from("execution_work_orders").insert({ decision_id: input.decisionId, work_order_code: input.workOrderCode,
      owner: input.owner.trim(), due_at: input.dueAt, action_items: input.actionItems.map((item) => item.trim()), created_by: input.actor.trim(), idempotency_key: input.idempotencyKey }).select("*").single();
    if (error) {
      const duplicate = await this.getByDecisionId(input.decisionId);
      if (duplicate) return { workOrder: duplicate, idempotent: true };
      throw error;
    }
    await this.client.from("execution_work_order_events").insert({ work_order_id: data.id, idempotency_key: input.idempotencyKey, actor: input.actor.trim(), previous_status: null, new_status: "OPEN", metadata: { event: "WORK_ORDER_CREATED" } });
    return { workOrder: map(data), idempotent: false };
  }
  async transition(decisionId: string, targetStatus: ExecutionWorkOrderStatus, actor: string, idempotencyKey: string): Promise<ExecutionWorkOrderMutationResult> {
    const current = await this.getByDecisionId(decisionId);
    if (!current) throw new Error("WORK_ORDER_NOT_FOUND");
    if (current.status === targetStatus) return { workOrder: current, idempotent: true };
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { status: targetStatus, updated_at: now };
    if (targetStatus === "IN_PROGRESS") patch.started_at = now;
    if (targetStatus === "COMPLETED") patch.completed_at = now;
    const { data, error } = await this.client.from("execution_work_orders").update(patch).eq("id", current.workOrderId).select("*").single();
    if (error) throw error;
    await this.client.from("execution_work_order_events").insert({ work_order_id: current.workOrderId, idempotency_key: idempotencyKey, actor, previous_status: current.status, new_status: targetStatus, metadata: {} });
    return { workOrder: map(data), idempotent: false };
  }
}
