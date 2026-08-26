import type { CreateExecutionWorkOrderInput, ExecutionWorkOrder, ExecutionWorkOrderStatus } from "@/domain/execution-work-order";

export interface ExecutionWorkOrderMutationResult { workOrder: ExecutionWorkOrder; idempotent: boolean; }

export interface IExecutionWorkOrderRepository {
  getByDecisionId(decisionId: string): Promise<ExecutionWorkOrder | null>;
  create(input: CreateExecutionWorkOrderInput & { workOrderCode: string }): Promise<ExecutionWorkOrderMutationResult>;
  transition(decisionId: string, targetStatus: ExecutionWorkOrderStatus, actor: string, idempotencyKey: string): Promise<ExecutionWorkOrderMutationResult>;
}
