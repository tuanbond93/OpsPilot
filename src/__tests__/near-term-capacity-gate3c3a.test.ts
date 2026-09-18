import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// Mock dependencies for route testing
const authorizeApiRequestMock = vi.fn();
const isCronAuthorizedMock = vi.fn();

vi.mock("@/security/api-security", () => ({
  authorizeApiRequest: (...args: any[]) => authorizeApiRequestMock(...args),
  isCronAuthorized: (...args: any[]) => isCronAuthorizedMock(...args),
}));

// Mock Supabase DB queries returned by createAdminClient
const mockClasses = [
  {
    vehicle_class: "TRUCK_1_9T",
    max_payload_kg: 1900,
    usable_payload_kg: 1600,
    volume_m3: 12,
    effective_at: "2026-09-01T00:00:00+07:00",
    provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
    source_ref: "OWNER_CONFIRMED:OPS_OWNER:2026-09-18",
  },
];

const mockRates = [
  {
    id: "r1",
    warehouse_id: "21160000",
    vehicle_class: "TRUCK_1_9T",
    supplier_name: "Thiên Phú",
    rate_vnd: 33551605,
    rate_basis: "MONTH",
    effective_at: "2026-09-01T00:00:00+07:00",
    contract_ref: null,
    provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
  },
  {
    id: "r2",
    warehouse_id: "21160000",
    vehicle_class: "TRUCK_1_9T",
    supplier_name: "Hoàng Minh",
    rate_vnd: 35663481,
    rate_basis: "MONTH",
    effective_at: "2026-09-01T00:00:00+07:00",
    contract_ref: null,
    provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
  },
  {
    id: "r3",
    warehouse_id: "21158000",
    vehicle_class: "TRUCK_1_9T",
    supplier_name: "Thuận Phát",
    rate_vnd: 36528734,
    rate_basis: "MONTH",
    effective_at: "2026-09-01T00:00:00+07:00",
    contract_ref: null,
    provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
  },
  {
    id: "r4",
    warehouse_id: "21158000",
    vehicle_class: "TRUCK_1_9T",
    supplier_name: "Hoàng Minh",
    rate_vnd: 38041046,
    rate_basis: "MONTH",
    effective_at: "2026-09-01T00:00:00+07:00",
    contract_ref: null,
    provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
  },
  {
    id: "r5",
    warehouse_id: "21161000",
    vehicle_class: "TRUCK_1_9T",
    supplier_name: "Hoàng Minh",
    rate_vnd: 36852263,
    rate_basis: "MONTH",
    effective_at: "2026-09-01T00:00:00+07:00",
    contract_ref: null,
    provenance_status: "OWNER_CONFIRMED_PENDING_DOCUMENT",
  },
];

function createQueryBuilder(initialData: any[]) {
  let currentData = [...initialData];
  const builder: any = {
    select: vi.fn().mockImplementation(() => builder),
    eq: vi.fn().mockImplementation((col: string, val: any) => {
      currentData = currentData.filter((row: any) => row[col] === val);
      return builder;
    }),
    in: vi.fn().mockImplementation((col: string, vals: any[]) => {
      currentData = currentData.filter((row: any) => vals.includes(row[col]));
      return builder;
    }),
    is: vi.fn().mockImplementation((col: string, val: any) => {
      currentData = currentData.filter(
        (row: any) => row[col] === val || (val === null && (row[col] === null || row[col] === undefined))
      );
      return builder;
    }),
    order: vi.fn().mockImplementation(() => builder),
    maybeSingle: vi.fn().mockImplementation(() =>
      Promise.resolve({ data: currentData[0] || null, error: null })
    ),
    then: (resolve: any, reject: any) =>
      Promise.resolve({ data: currentData, error: null }).then(resolve, reject),
  };
  return builder;
}

const mockDb = {
  from: (table: string) => {
    if (table === "governed_vehicle_classes") {
      return createQueryBuilder(mockClasses);
    }
    if (table === "governed_vehicle_rates") {
      return createQueryBuilder(mockRates);
    }
    if (table === "decision_followups" || table === "near_term_capacity_cases") {
      return createQueryBuilder([
        {
          id: "e48778a5-1ea1-48de-a596-6fe7f91fd73e",
          warehouse_id: "21160000",
          status: "DECISION_READY",
          updated_at: "2026-09-18T07:37:00.000Z",
        },
      ]);
    }
    return createQueryBuilder([]);
  },
};

vi.mock("@/connectors/supabase", () => ({
  createAdminClient: () => mockDb,
}));

import { GET } from "@/app/api/internal/governed-sources/verify-shadow/route";

function makeRequest(headers: Record<string, string> = {}) {
  return new NextRequest("https://opspilot-tau-lyart.vercel.app/api/internal/governed-sources/verify-shadow", {
    headers,
  });
}

describe("OpsPilot Level C Gate 3C.3A — Governed Source Verification Endpoint Security Closeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.LEVEL_C_VERIFY_SHADOW_ENABLED;
  });

  afterEach(() => {
    delete process.env.LEVEL_C_VERIFY_SHADOW_ENABLED;
  });

  it("0. route is disabled by default in production (returns 404 with zero diagnostic metadata)", async () => {
    delete process.env.LEVEL_C_VERIFY_SHADOW_ENABLED;

    const response = await GET(makeRequest());
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: "Not Found" });

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("rate_vnd");
    expect(raw).not.toContain("case_003");
    expect(raw).not.toContain("candidate_options");
    expect(raw).not.toContain("warehouse_option_counts");
  });

  it("0b. route returns 404 when LEVEL_C_VERIFY_SHADOW_ENABLED is set to false or arbitrary value", async () => {
    process.env.LEVEL_C_VERIFY_SHADOW_ENABLED = "false";
    const res1 = await GET(makeRequest());
    expect(res1.status).toBe(404);
    expect(await res1.json()).toEqual({ error: "Not Found" });

    process.env.LEVEL_C_VERIFY_SHADOW_ENABLED = "0";
    const res2 = await GET(makeRequest());
    expect(res2.status).toBe(404);

    process.env.LEVEL_C_VERIFY_SHADOW_ENABLED = "no";
    const res3 = await GET(makeRequest());
    expect(res3.status).toBe(404);
  });

  it("1. rejects unauthenticated public requests with HTTP 401 when flag is enabled", async () => {
    process.env.LEVEL_C_VERIFY_SHADOW_ENABLED = "true";
    isCronAuthorizedMock.mockReturnValue(false);
    authorizeApiRequestMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "AUTHENTICATION_REQUIRED" }, { status: 401 }),
    });

    const response = await GET(makeRequest());
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({ error: "AUTHENTICATION_REQUIRED" });
  });

  it("2. unauthenticated failure response body leaks zero pricing or rate data when flag is enabled", async () => {
    process.env.LEVEL_C_VERIFY_SHADOW_ENABLED = "true";
    isCronAuthorizedMock.mockReturnValue(false);
    authorizeApiRequestMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "AUTHENTICATION_REQUIRED" }, { status: 401 }),
    });

    const response = await GET(makeRequest());
    const text = await response.text();

    expect(text).not.toContain("rate_vnd");
    expect(text).not.toContain("33551605");
    expect(text).not.toContain("Thiên Phú");
    expect(text).not.toContain("Hoàng Minh");
    expect(text).not.toContain("Thuận Phát");
    expect(text).not.toContain("db_rates");
  });

  it("3. rejects callers lacking VIEW_SYSTEM permission with HTTP 403 when flag is enabled", async () => {
    process.env.LEVEL_C_VERIFY_SHADOW_ENABLED = "true";
    isCronAuthorizedMock.mockReturnValue(false);
    authorizeApiRequestMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { error: "PERMISSION_DENIED", requiredPermission: "VIEW_SYSTEM" },
        { status: 403 }
      ),
    });

    const response = await GET(makeRequest({ authorization: "Bearer invalid_user_token" }));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("PERMISSION_DENIED");
    expect(body.requiredPermission).toBe("VIEW_SYSTEM");
  });

  it("4. accepts authorized callers with CRON_SECRET (Bearer token) when flag is enabled", async () => {
    process.env.LEVEL_C_VERIFY_SHADOW_ENABLED = "true";
    isCronAuthorizedMock.mockReturnValue(true);

    const response = await GET(makeRequest({ authorization: "Bearer valid_cron_secret" }));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.source_read_success).toBe(true);
  });

  it("5. minimizes authorized diagnostic response and strictly omits rate_vnd and supplier names when flag is enabled", async () => {
    process.env.LEVEL_C_VERIFY_SHADOW_ENABLED = "true";
    isCronAuthorizedMock.mockReturnValue(true);

    const response = await GET(makeRequest({ authorization: "Bearer valid_cron_secret" }));
    expect(response.status).toBe(200);

    const rawJson = JSON.stringify(await response.json());

    // Sensitive pricing fields must NOT be present
    expect(rawJson).not.toContain("rate_vnd");
    expect(rawJson).not.toContain("33551605");
    expect(rawJson).not.toContain("35663481");
    expect(rawJson).not.toContain("36528734");
    expect(rawJson).not.toContain("38041046");
    expect(rawJson).not.toContain("36852263");
    expect(rawJson).not.toContain("Thiên Phú");
    expect(rawJson).not.toContain("Hoàng Minh");
    expect(rawJson).not.toContain("Thuận Phát");
    expect(rawJson).not.toContain("db_rates");
    expect(rawJson).not.toContain("rates_details");
  });

  it("6. authorized response provides bounded verification metadata when flag is enabled", async () => {
    process.env.LEVEL_C_VERIFY_SHADOW_ENABLED = "true";
    isCronAuthorizedMock.mockReturnValue(true);

    const response = await GET(makeRequest({ authorization: "Bearer valid_cron_secret" }));
    const data = await response.json();

    expect(data.source_read_success).toBe(true);
    expect(data.class_count).toBe(1);
    expect(data.rate_count).toBe(5);
    expect(data.warehouse_option_counts).toEqual({
      phu_tho: 2,
      lao_cai: 2,
      yen_bai: 1,
    });
    expect(data.evidence_status).toBe("OWNER_CONFIRMED");
    expect(data.comparison_status).toBe("PARTIAL");
    expect(data.case_003.shadow_recommendation).toBe("REQUEST_MORE_INFORMATION");
  });

  it("7. verifies Supabase RLS is SERVICE_ROLE_ONLY in Migration 078", () => {
    const migrationPath = path.resolve(
      __dirname,
      "../database/migrations/078_governed_vehicle_source_infrastructure.sql"
    );
    const sql = fs.readFileSync(migrationPath, "utf-8");

    // All three tables must have RLS enabled
    expect(sql).toContain("ALTER TABLE public.governed_vehicle_classes ENABLE ROW LEVEL SECURITY;");
    expect(sql).toContain("ALTER TABLE public.governed_vehicle_rates ENABLE ROW LEVEL SECURITY;");
    expect(sql).toContain("ALTER TABLE public.vehicle_fleet_availability ENABLE ROW LEVEL SECURITY;");

    // All authenticated / public read policies must be dropped
    expect(sql).toContain('DROP POLICY IF EXISTS "Allow authenticated read on governed_vehicle_classes"');
    expect(sql).toContain('DROP POLICY IF EXISTS "Allow authenticated read on governed_vehicle_rates"');
    expect(sql).toContain('DROP POLICY IF EXISTS "Allow authenticated read on vehicle_fleet_availability"');

    // Access must be strictly service_role full access only
    expect(sql).toContain(
      'CREATE POLICY "Allow service role full access on governed_vehicle_classes"\n  ON public.governed_vehicle_classes FOR ALL TO service_role USING (true) WITH CHECK (true);'
    );
    expect(sql).toContain(
      'CREATE POLICY "Allow service role full access on governed_vehicle_rates"\n  ON public.governed_vehicle_rates FOR ALL TO service_role USING (true) WITH CHECK (true);'
    );
    expect(sql).toContain(
      'CREATE POLICY "Allow service role full access on vehicle_fleet_availability"\n  ON public.vehicle_fleet_availability FOR ALL TO service_role USING (true) WITH CHECK (true);'
    );
  });

  it("8. route does NOT act as a public proxy bypassing RLS when flag is enabled", async () => {
    process.env.LEVEL_C_VERIFY_SHADOW_ENABLED = "true";
    // Unauthenticated callers cannot trigger Supabase service role queries through this route
    isCronAuthorizedMock.mockReturnValue(false);
    authorizeApiRequestMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "AUTHENTICATION_REQUIRED" }, { status: 401 }),
    });

    const response = await GET(makeRequest());
    expect(response.status).toBe(401);
  });

  it("9. preserves all shadow safety invariants when flag is enabled", async () => {
    process.env.LEVEL_C_VERIFY_SHADOW_ENABLED = "true";
    isCronAuthorizedMock.mockReturnValue(true);

    const response = await GET(makeRequest({ authorization: "Bearer valid_cron_secret" }));
    const data = await response.json();

    expect(data.safety_invariants.natural_evidence_contaminated).toBe(false);
    expect(data.safety_invariants.case_003_production_mutated).toBe(false);
    expect(data.safety_invariants.telegram_sent).toBe(false);
    expect(data.safety_invariants.work_order_created).toBe(false);
  });

  it("10. owner data provenance status remains OWNER_CONFIRMED when flag is enabled", async () => {
    process.env.LEVEL_C_VERIFY_SHADOW_ENABLED = "true";
    isCronAuthorizedMock.mockReturnValue(true);

    const response = await GET(makeRequest({ authorization: "Bearer valid_cron_secret" }));
    const data = await response.json();

    expect(data.class_evidence_status).toBe("OWNER_CONFIRMED");
    expect(data.rate_evidence_status).toBe("OWNER_CONFIRMED");
    expect(data.case_003.cost_comparison_status).toBe("PARTIAL");
    expect(data.case_003.capacity_comparison_status).toBe("AVAILABLE");
  });

  it("11. Gate 3D.3 / near-term capacity runtime engine path remains unaffected regardless of flag state", async () => {
    const { runMultiOptionEvaluation } = await import("@/domain/near-term-capacity/multi-option/engine");
    const { GovernedVehicleSourceAdapter } = await import("@/domain/near-term-capacity/multi-option/sources/vehicle-source-adapter");

    const risk = {
      warehouseId: "21160000",
      warehouseName: "Phú Thọ",
      capturedAt: "2026-09-18T07:00:00.000Z",
      currentOrders: 50,
      currentKg: 6000,
      b2bOrders: null,
      evidenceRefs: ["test:runtime"],
      riskSignals: ["KHO_TON"],
      hardSlaConstraint: "Risk",
    };

    // Disabled flag (default)
    delete process.env.LEVEL_C_VERIFY_SHADOW_ENABLED;
    const adapter1 = new GovernedVehicleSourceAdapter({});
    const res1 = await runMultiOptionEvaluation(risk, null, { vehicleSourceAdapter: adapter1 });
    expect(res1.recommended_option).toBe("INSUFFICIENT_EVIDENCE");

    // Enabled flag
    process.env.LEVEL_C_VERIFY_SHADOW_ENABLED = "true";
    const adapter2 = new GovernedVehicleSourceAdapter({});
    const res2 = await runMultiOptionEvaluation(risk, null, { vehicleSourceAdapter: adapter2 });
    expect(res2.recommended_option).toBe("INSUFFICIENT_EVIDENCE");
    expect(res1.recommended_option).toBe(res2.recommended_option);
    expect(res1.candidate_options.length).toBe(res2.candidate_options.length);
  });
});
