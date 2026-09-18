import type { CurrentRisk } from "../loop";
import type { DecisionOption, MultiOptionMatrix, MultiOptionMatrixRow, RootCauseEvaluation } from "./types";
import { formatCostDisplay } from "./evaluators/cost-evaluator";
import { formatCapacityDisplay } from "./evaluators/capacity-evaluator";
import { formatSlaDisplay } from "./evaluators/sla-evaluator";

export function buildMultiOptionMatrix(
  caseId: string,
  facts: CurrentRisk,
  rootCause: RootCauseEvaluation,
  options: DecisionOption[]
): MultiOptionMatrix {
  const rows: MultiOptionMatrixRow[] = options.map((opt) => {
    const costText = formatCostDisplay(opt.cost);
    const capacityText = formatCapacityDisplay(opt.capacity);
    const slaText = formatSlaDisplay(opt.sla);

    const mainRisk = opt.feasibility_reason
      ? `Điều kiện / Trở ngại: ${opt.feasibility_reason}`
      : opt.risks[0] || "Không xác định";

    return {
      option: opt.description,
      option_type: opt.option_type,
      feasibility_status: opt.feasibility_status,
      feasibility_reason: opt.feasibility_reason,
      feasibility_evidence: opt.feasibility_evidence || null,
      economic_status: opt.economic.status,
      economic_evidence: opt.economic_evidence || null,
      incremental_cost_display: costText,
      cost_display: costText,
      projected_cost_diff_display: opt.projected_cost_difference_display || "UNKNOWN",
      capacity_impact: capacityText,
      sla_impact: slaText,
      main_risk: mainRisk,
      unknown_fields: opt.unknowns,
      feasible: opt.feasible,
    };
  });

  return {
    case_id: caseId,
    warehouse_id: facts.warehouseId,
    warehouse_name: facts.warehouseName,
    root_cause: rootCause,
    rows,
    options,
  };
}

export function formatOptionMatrixMarkdown(matrix: MultiOptionMatrix): string {
  const header = [
    `### BẢNG SO SÁNH PHƯƠNG ÁN RA QUYẾT ĐỊNH (SHADOW GATE 3A.2)`,
    `Kho: **${matrix.warehouse_name}** | Nguyên nhân gốc rễ: **${matrix.root_cause.category}** (Độ tin cậy: ${Math.round(matrix.root_cause.confidence * 100)}%)`,
    "",
    "| Phương án | Khả thi | Đánh giá kinh tế | Chi phí phát sinh | Năng lực bổ sung | Tác động SLA | Rủi ro / Điều kiện |",
    "|---|---|---|---|---|---|---|",
  ];

  const lines = matrix.rows.map((r) => {
    const feasBadge =
      r.feasibility_status === "FEASIBLE"
        ? "✅ FEASIBLE"
        : r.feasibility_status === "CONDITIONALLY_FEASIBLE"
          ? "⚠️ CONDITIONAL"
          : r.feasibility_status === "INFEASIBLE"
            ? "❌ INFEASIBLE"
            : "❓ UNKNOWN";
    return `| **${r.option_type}** | ${feasBadge} | ${r.economic_status} | ${r.incremental_cost_display} | ${r.capacity_impact} | ${r.sla_impact} | ${r.main_risk} |`;
  });

  return [...header, ...lines].join("\n");
}
