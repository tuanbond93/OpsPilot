import type { CreateExecutionWorkOrderInput, ExecutionWorkOrder, ExecutionWorkOrderStatus } from "@/domain/execution-work-order";
import type { ExecutionWorkOrderMutationResult, IExecutionWorkOrderRepository } from "../interfaces/IExecutionWorkOrderRepository";

export class MockExecutionWorkOrderRepository implements IExecutionWorkOrderRepository {
  private rows = new Map<string, ExecutionWorkOrder>();
  async getByDecisionId(decisionId: string) { return this.rows.get(decisionId) || null; }
  async create(input: CreateExecutionWorkOrderInput & { workOrderCode: string }): Promise<ExecutionWorkOrderMutationResult> {
    const existing = this.rows.get(input.decisionId); if (existing) return { workOrder: existing, idempotent: true };
    const row: ExecutionWorkOrder = { workOrderId: crypto.randomUUID(), decisionId: input.decisionId, workOrderCode: input.workOrderCode, status: "OPEN", owner: input.owner.trim(), dueAt: input.dueAt, actionItems: input.actionItems.map((item) => item.trim()), createdBy: input.actor.trim(), createdAt: new Date().toISOString() };
    this.rows.set(input.decisionId, row); return { workOrder: row, idempotent: false };
  }
  async transition(decisionId: string, targetStatus: ExecutionWorkOrderStatus): Promise<ExecutionWorkOrderMutationResult> {
    const current = this.rows.get(decisionId); if (!current) throw new Error("WORK_ORDER_NOT_FOUND");
    if (current.status === targetStatus) return { workOrder: current, idempotent: true };
    const now = new Date().toISOString(); const row = { ...current, status: targetStatus, startedAt: targetStatus === "IN_PROGRESS" ? now : current.startedAt, completedAt: targetStatus === "COMPLETED" ? now : current.completedAt } as ExecutionWorkOrder;
    this.rows.set(decisionId, row); return { workOrder: row, idempotent: false };
  }
}
