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
    const costText = opt.feasible
      ? formatCostDisplay(opt.cost)
      : opt.cost.value_vnd !== null
        ? formatCostDisplay(opt.cost)
        : "UNKNOWN (Không khả thi)";

    const capacityText = opt.feasible
      ? formatCapacityDisplay(opt.capacity)
      : "UNKNOWN (Không khả thi)";

    const slaText = opt.feasible
      ? formatSlaDisplay(opt.sla)
      : "UNKNOWN (Không khả thi)";

    const mainRisk = opt.infeasible_reason
      ? `Không khả thi: ${opt.infeasible_reason}`
      : opt.risks[0] || "Không xác định";

    return {
      option: opt.description,
      option_type: opt.option_type,
      feasible: opt.feasible,
      cost_display: costText,
      capacity_impact: capacityText,
      sla_impact: slaText,
      main_risk: mainRisk,
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
    `### BẢNG SO SÁNH PHƯƠNG ÁN RA QUYẾT ĐỊNH (SHADOW GATE 3A)`,
    `Kho: **${matrix.warehouse_name}** | Nguyên nhân gốc rễ: **${matrix.root_cause.category}** (Độ tin cậy: ${Math.round(matrix.root_cause.confidence * 100)}%)`,
    "",
    "| Phương án | Khả thi | Chi phí (VND) | Tác động năng lực | Tác động SLA | Rủi ro chính / Lý do |",
    "|---|---|---|---|---|---|",
  ];

  const lines = matrix.rows.map((r) => {
    const feasibleStr = r.feasible ? "✅ CÓ" : "❌ KHÔNG";
    return `| **${r.option_type}** | ${feasibleStr} | ${r.cost_display} | ${r.capacity_impact} | ${r.sla_impact} | ${r.main_risk} |`;
  });

  return [...header, ...lines].join("\n");
}
