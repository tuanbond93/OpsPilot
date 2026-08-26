export type ExecutionWorkOrderStatus = "OPEN" | "IN_PROGRESS" | "COMPLETED";

export interface ExecutionWorkOrder {
  workOrderId: string;
  decisionId: string;
  workOrderCode: string;
  status: ExecutionWorkOrderStatus;
  owner: string;
  dueAt: string;
  actionItems: string[];
  createdBy: string;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface CreateExecutionWorkOrderInput {
  decisionId: string;
  actor: string;
  idempotencyKey: string;
  owner: string;
  dueAt: string;
  actionItems: string[];
}

export interface TransitionExecutionWorkOrderInput {
  decisionId: string;
  actor: string;
  idempotencyKey: string;
  targetStatus: ExecutionWorkOrderStatus;
}

export class ExecutionWorkOrderError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function text(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || !value.trim()) throw new ExecutionWorkOrderError("VALIDATION_ERROR", `${field} is required.`);
  const result = value.trim();
  if (result.length > max) throw new ExecutionWorkOrderError("VALIDATION_ERROR", `${field} is too long.`);
  return result;
}

export function validateCreateExecutionWorkOrder(input: CreateExecutionWorkOrderInput): void {
  text(input.decisionId, "decisionId", 200); text(input.actor, "actor", 200); text(input.idempotencyKey, "idempotencyKey", 200);
  text(input.owner, "owner", 200);
  if (!Number.isFinite(Date.parse(input.dueAt))) throw new ExecutionWorkOrderError("VALIDATION_ERROR", "dueAt must be a valid timestamp.");
  if (!Array.isArray(input.actionItems) || input.actionItems.length === 0 || input.actionItems.length > 30) {
    throw new ExecutionWorkOrderError("VALIDATION_ERROR", "actionItems must contain 1 to 30 items.");
  }
  input.actionItems.forEach((item, index) => text(item, `actionItems[${index}]`, 2000));
}

export function buildWorkOrderCode(decisionId: string, at = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const dateStamp = ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value).join("");
  const shortId = decisionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase() || "UNKNOWN";
  return `OPSP-WO-${dateStamp}-${shortId}-01`;
}
