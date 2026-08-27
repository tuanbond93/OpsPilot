import { NextRequest, NextResponse } from "next/server";
import { findCanonicalWarehouse } from "@/connectors/ghn-order-tracking/warehouse-directory";

const WAREHOUSE_ID = /^\d{1,12}$/;

export function GET(request: NextRequest) {
  const ids = [...new Set((request.nextUrl.searchParams.get("ids") || "").split(",").map((value) => value.trim()).filter((value) => WAREHOUSE_ID.test(value)))].slice(0, 50);
  const warehouses = Object.fromEntries(ids.flatMap((warehouseId) => {
    const warehouse = findCanonicalWarehouse(warehouseId);
    return warehouse ? [[warehouseId, { name: warehouse.warehouseName, type: warehouse.warehouseType }]] : [];
  }));
  return NextResponse.json({ warehouses }, { headers: { "cache-control": "public, max-age=86400, s-maxage=86400" } });
}
