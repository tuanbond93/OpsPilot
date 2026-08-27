import type { Decision } from "@/domain/decision";
import type { ExecutionWorkOrder } from "@/domain/execution-work-order";

type EvidenceGroup = { title?: unknown; warehouseName?: unknown; action?: unknown; orderCodes?: unknown; orderCount?: unknown };

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

/** Select only the evidence group(s) represented by this work order's owner and action. */
export function workOrderEvidence(decision: Decision, workOrder: ExecutionWorkOrder) {
  const facts = decision.evidence.operationalFacts;
  const groups = Array.isArray(facts.groups) ? facts.groups.filter((group): group is EvidenceGroup => Boolean(group) && typeof group === "object") : [];
  const selected = groups.filter((group) => {
    const sameOwner = typeof group.warehouseName === "string" && group.warehouseName.trim() === workOrder.owner;
    const action = typeof group.action === "string" ? group.action.trim() : "";
    return sameOwner && workOrder.actionItems.some((item) => item.trim() === action);
  });
  const matched = selected.length ? selected : groups.filter((group) => typeof group.warehouseName === "string" && group.warehouseName.trim() === workOrder.owner);
  const orderCodes = [...new Set(matched.flatMap((group) => strings(group.orderCodes)))].slice(0, 8);
  const fallbackCodes = strings(facts.sampleOrderCodes).slice(0, 5);
  const titles = [...new Set(matched.map((group) => typeof group.title === "string" ? group.title.trim() : "").filter(Boolean))].slice(0, 3);
  const total = matched.reduce((count, group) => count + (typeof group.orderCount === "number" && Number.isFinite(group.orderCount) ? group.orderCount : 0), 0);
  return { orderCodes: orderCodes.length ? orderCodes : fallbackCodes, groupTitles: titles, affectedOrderCount: total || null };
}
