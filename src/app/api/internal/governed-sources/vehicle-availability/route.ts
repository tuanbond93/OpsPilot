import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRequest, isCronAuthorized } from "@/security/api-security";
import { createAdminClient } from "@/connectors/supabase";
import {
  validateVehicleAvailabilityInput,
  persistVehicleAvailabilityFact,
} from "@/domain/near-term-capacity/multi-option/sources/vehicle-availability-service";
import { isWithinDeliveryOperatingWindow } from "@/domain/near-term-capacity/operating-window";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  // 1. Authorization: Only CRON_SECRET or authorized operational session with VIEW_SYSTEM/MANAGE_SYSTEM
  const isCron = isCronAuthorized(request);
  let serverIdentity: any = null;
  if (!isCron) {
    const auth = await authorizeApiRequest(request, "VIEW_SYSTEM", { limit: 30, windowMs: 60_000 });
    if (!auth.ok) {
      return auth.response;
    }
    serverIdentity = auth.identity;
  }

  try {
    let body: any = null;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "INVALID_JSON: Body must be valid JSON object" }, { status: 400 });
    }

    // 2. Validate Fact Contract & Operational Actor Role
    const validation = validateVehicleAvailabilityInput(body, { isCron, identity: serverIdentity });
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: validation.status });
    }

    // 3. Persist via server-side service role client
    const db = createAdminClient();
    const persistResult = await persistVehicleAvailabilityFact(db, validation.fact);

    if (!persistResult.ok) {
      return NextResponse.json(
        { ok: false, error: persistResult.error },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      fact_id: persistResult.id,
      superseded_fact_id: persistResult.superseded_id || null,
      fact: validation.fact,
      message: persistResult.superseded_id
        ? "Prior fact superseded and corrected vehicle availability fact persisted successfully."
        : "Authorized vehicle availability fact persisted successfully.",
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  // 1. Authorization: Same security boundary
  const isCron = isCronAuthorized(request);
  if (!isCron) {
    const auth = await authorizeApiRequest(request, "VIEW_SYSTEM", { limit: 30, windowMs: 60_000 });
    if (!auth.ok) {
      return auth.response;
    }
  }

  try {
    const db = createAdminClient();
    const searchParams = request.nextUrl.searchParams;
    const warehouseId = searchParams.get("warehouseId");
    const includeSuperseded = searchParams.get("include_superseded") === "true";

    let query = db
      .from("vehicle_fleet_availability")
      .select("id, warehouse_id, supplier_name, vehicle_class, available, available_count, available_at, captured_at, valid_until, source_ref, supplied_by, supplier_role, superseded_at, superseded_by, supersedes_fact_id, supersession_reason")
      .order("captured_at", { ascending: false });

    if (warehouseId) {
      query = query.eq("warehouse_id", warehouseId);
    }

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const now = Date.now();
    const isOutsideOperatingWindow = !isWithinDeliveryOperatingWindow(now);

    const allRows = (data || []).map((row) => {
      const isExpired = row.valid_until ? now > new Date(row.valid_until).getTime() : false;
      const isSuperseded = Boolean(row.superseded_at);
      const isAvailableNow = row.available_count > 0 &&
        (!row.available_at || new Date(row.available_at).getTime() <= now) &&
        !isExpired &&
        !isSuperseded;
      const isScheduled = row.available_count > 0 &&
        row.available_at &&
        new Date(row.available_at).getTime() > now &&
        !isExpired &&
        !isSuperseded;

      let availStatus: string;
      if (isSuperseded) {
        availStatus = "SUPERSEDED";
      } else if (isOutsideOperatingWindow) {
        availStatus = "OUTSIDE_OPERATING_WINDOW";
      } else if (isExpired) {
        availStatus = "UNKNOWN";
      } else if (row.available_count === 0) {
        availStatus = "UNAVAILABLE";
      } else if (isAvailableNow) {
        availStatus = "AVAILABLE_NOW";
      } else if (isScheduled) {
        availStatus = "SCHEDULED_AVAILABLE";
      } else {
        availStatus = "UNKNOWN";
      }

      return {
        ...row,
        is_expired: isExpired,
        is_superseded: isSuperseded,
        availability_status: availStatus,
        evidence_status: isExpired || isSuperseded || isOutsideOperatingWindow
          ? (isOutsideOperatingWindow && !isSuperseded ? "OUTSIDE_OPERATING_WINDOW" : "UNKNOWN")
          : (row.source_ref && row.source_ref.startsWith("SYSTEM_AUTHORIZED_IMPORT"))
          ? "SYSTEM_AUTHORIZED_IMPORT"
          : "AUTHORIZED_OPERATIONAL_FACT",
      };
    });

    // Deduplicate current unsuperseded facts by (warehouse_id, vehicle_class, supplier_name)
    const seenTuples = new Set<string>();
    const currentFacts = allRows.filter((fact) => {
      if (fact.is_superseded) return false;
      const tupleKey = `${fact.warehouse_id}::${fact.vehicle_class}::${(fact.supplier_name || "").toUpperCase()}`;
      if (seenTuples.has(tupleKey)) return false;
      seenTuples.add(tupleKey);
      return true;
    });

    return NextResponse.json({
      ok: true,
      total_count: currentFacts.length,
      active_non_expired_count: currentFacts.filter((f) => !f.is_expired).length,
      facts: includeSuperseded ? allRows : currentFacts,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500 }
    );
  }
}
