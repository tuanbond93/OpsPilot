import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRequest, isCronAuthorized } from "@/security/api-security";
import { createAdminClient } from "@/connectors/supabase";
import {
  validateVehicleAvailabilityInput,
  persistVehicleAvailabilityFact,
} from "@/domain/near-term-capacity/multi-option/sources/vehicle-availability-service";

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
      fact: validation.fact,
      message: "Authorized vehicle availability fact persisted successfully.",
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

    let query = db
      .from("vehicle_fleet_availability")
      .select("id, warehouse_id, supplier_name, vehicle_class, available, available_count, available_at, captured_at, valid_until, source_ref, supplied_by, supplier_role")
      .order("captured_at", { ascending: false });

    if (warehouseId) {
      query = query.eq("warehouse_id", warehouseId);
    }

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const now = Date.now();
    const activeFacts = (data || []).map((row) => {
      const isExpired = row.valid_until ? now > new Date(row.valid_until).getTime() : false;
      const isAvailableNow = row.available_count > 0 &&
        (!row.available_at || new Date(row.available_at).getTime() <= now) &&
        !isExpired;
      const isScheduled = row.available_count > 0 &&
        row.available_at &&
        new Date(row.available_at).getTime() > now &&
        !isExpired;

      const availStatus = isExpired
        ? "UNKNOWN"
        : row.available_count === 0
        ? "UNAVAILABLE"
        : isAvailableNow
        ? "AVAILABLE_NOW"
        : isScheduled
        ? "SCHEDULED_AVAILABLE"
        : "UNKNOWN";

      return {
        ...row,
        is_expired: isExpired,
        availability_status: availStatus,
        evidence_status: isExpired
          ? "UNKNOWN"
          : (row.source_ref && row.source_ref.startsWith("SYSTEM_AUTHORIZED_IMPORT"))
          ? "SYSTEM_AUTHORIZED_IMPORT"
          : "AUTHORIZED_OPERATIONAL_FACT",
      };
    });

    return NextResponse.json({
      ok: true,
      total_count: activeFacts.length,
      active_non_expired_count: activeFacts.filter((f) => !f.is_expired).length,
      facts: activeFacts,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500 }
    );
  }
}
