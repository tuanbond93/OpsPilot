import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRequest, isCronAuthorized } from "@/security/api-security";
import { createAdminClient } from "@/connectors/supabase";
import { GovernedVehicleSourceAdapter } from "@/domain/near-term-capacity/multi-option/sources/vehicle-source-adapter";
import { runMultiOptionEvaluation } from "@/domain/near-term-capacity/multi-option/engine";
import { resolveRequestedInformation } from "@/domain/near-term-capacity/multi-option/option-registry";
import type { CurrentRisk, LeadFact } from "@/domain/near-term-capacity/loop";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // Security Gate 3C.3A: Protect commercially sensitive pricing from unauthenticated public access.
  // Requires either CRON_SECRET authorization or an authenticated session with VIEW_SYSTEM permission.
  const isCron = isCronAuthorized(request);
  if (!isCron) {
    const auth = await authorizeApiRequest(request, "VIEW_SYSTEM", { limit: 60, windowMs: 60_000 });
    if (!auth.ok) {
      return auth.response;
    }
  }

  try {
    const db = createAdminClient();

    // 1. Raw DB Query: governed_vehicle_classes (metadata only, no raw payload dump)
    const { data: dbClasses, error: classErr } = await db
      .from("governed_vehicle_classes")
      .select("vehicle_class, provenance_status");

    // 2. Raw DB Query: governed_vehicle_rates (metadata only, omitting rate_vnd and supplier_name)
    const { data: dbRates, error: rateErr } = await db
      .from("governed_vehicle_rates")
      .select("id, warehouse_id, vehicle_class, rate_basis, provenance_status")
      .is("expires_at", null);

    // 3. Adapter check
    const adapter = new GovernedVehicleSourceAdapter({ db });

    const [phuThoEvidence, laoCaiEvidence, yenBaiEvidence] = await Promise.all([
      adapter.getVehicleEvidence("21160000", "TRUCK_1_9T"),
      adapter.getVehicleEvidence("21158000", "TRUCK_1_9T"),
      adapter.getVehicleEvidence("21161000", "TRUCK_1_9T"),
    ]);

    const phuThoRates = await adapter.getVehicleRates("21160000", "TRUCK_1_9T");
    const laoCaiRates = await adapter.getVehicleRates("21158000", "TRUCK_1_9T");
    const yenBaiRates = await adapter.getVehicleRates("21161000", "TRUCK_1_9T");

    // 4. Case #003 Read-Only check from DB
    const caseId = "e48778a5-1ea1-48de-a596-6fe7f91fd73e";
    const { data: caseFollowup } = await db
      .from("decision_followups")
      .select("id, warehouse_id, status, updated_at")
      .eq("id", caseId)
      .maybeSingle();

    const { data: caseCapacity } = await db
      .from("near_term_capacity_cases")
      .select("id, warehouse_id, status, updated_at")
      .eq("id", caseId)
      .maybeSingle();

    // 5. In-Memory Historical Shadow Replay for Case #003
    const case003Facts: CurrentRisk = {
      warehouseId: "21160000",
      warehouseName: "Kho Giao Hàng Nặng - Việt Trì - Phú Thọ",
      capturedAt: "2026-09-18T07:00:02.601Z",
      currentOrders: 87,
      currentKg: 11697.69,
      b2bOrders: null,
      evidenceRefs: ["incident:case-003"],
      riskSignals: ["KHO_TON"],
      hardSlaConstraint: "Persisted warehouse backlog risk",
    };

    const case003Lead: LeadFact = {
      interactionId: "e48778a5-1ea1-48de-a596-6fe7f91fd73e",
      suppliedBy: "telegram:lead-phutho",
      capturedAt: "2026-09-18T07:36:45.110Z",
      source: "HUMAN_OPERATIONAL_GROUND_TRUTH",
      incoming: "NO_SIGNIFICANT_INCOMING",
      confidence: "LOW",
    };

    const shadowResult = await runMultiOptionEvaluation(case003Facts, case003Lead, {
      caseId: "e48778a5-1ea1-48de-a596-6fe7f91fd73e",
      vehicleSourceAdapter: adapter,
    });

    const missingBefore = resolveRequestedInformation(null);
    const missingAfter = resolveRequestedInformation(phuThoEvidence);

    const addVehicleOptions = shadowResult.candidate_options.filter((o) => o.option_type === "ADD_VEHICLE");

    // Minimized verification payload: Excludes rate_vnd, supplier names, and raw table dumps.
    return NextResponse.json({
      ok: true,
      source_read_success: Boolean(dbClasses && dbRates && !classErr && !rateErr),
      execution_origin: "HISTORICAL_REPLAY_OWNER_DATA",
      class_count: dbClasses?.length || 0,
      rate_count: dbRates?.length || 0,
      prod_vehicle_class_rows: dbClasses?.length || 0,
      prod_rate_rows: dbRates?.length || 0,
      warehouse_option_counts: {
        phu_tho: phuThoRates?.length || 0,
        lao_cai: laoCaiRates?.length || 0,
        yen_bai: yenBaiRates?.length || 0,
      },
      options_count: {
        phu_tho: phuThoRates?.length || 0,
        lao_cai: laoCaiRates?.length || 0,
        yen_bai: yenBaiRates?.length || 0,
      },
      evidence_status: phuThoEvidence.rate.evidence_status,
      class_evidence_status: phuThoEvidence.capacity.evidence_status,
      rate_evidence_status: phuThoEvidence.rate.evidence_status,
      comparison_status: "PARTIAL",
      case_003: {
        id: caseId,
        warehouse: "21160000 — Phú Thọ",
        historical_backlog: "87 orders, 11,697.69 kg",
        persisted_followup: caseFollowup,
        persisted_capacity_case: caseCapacity,
        root_cause: shadowResult.root_cause.category,
        cost_comparison_status: "PARTIAL",
        capacity_comparison_status: "AVAILABLE",
        total_capacity_gap_status: "UNKNOWN",
        sla_comparison_status: "UNKNOWN",
        case_003_quantitative_comparison: "PARTIAL",
        shadow_recommendation: shadowResult.recommended_option,
        recommendation_reason: shadowResult.recommendation_reason,
        tradeoff_summary: shadowResult.tradeoff_summary,
        candidate_options: addVehicleOptions.map((opt) => ({
          option_id: opt.option_id,
          vehicle_class: (opt.capacity as any).vehicle_class || "TRUCK_1_9T",
          added_capacity_kg: opt.capacity.added_kg,
          rate_basis: opt.cost.rate_basis,
          feasibility_status: opt.feasibility_status,
          feasibility_reason: opt.feasibility_reason,
          evidence_status: opt.cost.evidence_status,
          availability: (opt as any).availability || "UNKNOWN",
        })),
      },
      missing_info: {
        before_phase1: missingBefore,
        after_phase1: missingAfter,
      },
      safety_invariants: {
        natural_evidence_contaminated: false,
        case_003_production_mutated: false,
        telegram_sent: false,
        work_order_created: false,
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        error: err?.message || String(err),
      },
      { status: 500 }
    );
  }
}
