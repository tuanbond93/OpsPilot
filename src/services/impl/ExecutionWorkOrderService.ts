import type { IDecisionRepository } from "@/repositories/interfaces/IDecisionRepository";
import type { IExecutionWorkOrderRepository } from "@/repositories/interfaces/IExecutionWorkOrderRepository";
import { buildWorkOrderCode, ExecutionWorkOrderError, type CreateExecutionWorkOrderInput, type TransitionExecutionWorkOrderInput, validateCreateExecutionWorkOrder } from "@/domain/execution-work-order";

export class ExecutionWorkOrderService {
  constructor(private readonly decisions: IDecisionRepository, private readonly workOrders: IExecutionWorkOrderRepository) {}
  async get(decisionId: string) { return this.workOrders.getByDecisionId(decisionId); }
  async create(input: CreateExecutionWorkOrderInput) {
    validateCreateExecutionWorkOrder(input);
    const decision = await this.decisions.getById(input.decisionId);
    if (!decision) throw new ExecutionWorkOrderError("NOT_FOUND", "Decision not found.");
    if (decision.mode !== "HUMAN_APPROVAL" || decision.decisionStatus !== "APPROVED") throw new ExecutionWorkOrderError("DECISION_NOT_APPROVED", "A work order can only be created for an approved HUMAN_APPROVAL decision.");
    return this.workOrders.create({ ...input, workOrderCode: buildWorkOrderCode(input.decisionId) });
  }
  async transition(input: TransitionExecutionWorkOrderInput) {
    const current = await this.workOrders.getByDecisionId(input.decisionId);
    if (!current) throw new ExecutionWorkOrderError("NOT_FOUND", "Work order not found.");
    const allowed = (current.status === "OPEN" && input.targetStatus === "IN_PROGRESS") || (current.status === "IN_PROGRESS" && input.targetStatus === "COMPLETED");
    if (!allowed && current.status !== input.targetStatus) throw new ExecutionWorkOrderError("INVALID_TRANSITION", `${current.status} cannot transition to ${input.targetStatus}.`);
    return this.workOrders.transition(input.decisionId, input.targetStatus, input.actor, input.idempotencyKey);
  }
}
