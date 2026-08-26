import { RillnetClient } from "../src/connectors/rillnet/client";
import { decompressSnapshot } from "../src/connectors/rillnet/snapshot";
import { parseSnapshot } from "../src/connectors/rillnet/parser";

const wanted = new Set(["GY8K9UQ9", "GY847CLM_CPTT"]);
const client = new RillnetClient();
const { downloadUrl, updatedAt } = await client.requestSnapshotUrl();
const buffer = await client.downloadSnapshotBuffer(downloadUrl);
const rows = parseSnapshot(await decompressSnapshot(buffer)).filter((row) => wanted.has(String(row.order_code || row.code || "")));
const meta = await client.fetchWarehouseMeta();

const results = rows.map((row) => {
  let warehouseLog: unknown = row.warehouse_log;
  if (typeof warehouseLog === "string") {
    try { warehouseLog = JSON.parse(warehouseLog); } catch { /* retain malformed raw string */ }
  }
  const ids = [row.current_warehouse_id, row.pick_warehouse_id, row.deliver_warehouse_id, ...(Array.isArray(warehouseLog) ? warehouseLog.map((item) => item && typeof item === "object" ? (item as any).warehouse_id : null) : [])]
    .filter((id) => id !== null && id !== undefined && String(id) !== "");
  const warehouseNames = Object.fromEntries(ids.map((id) => [String(id), meta[String(id)]?.p || (meta[String(id)] as any)?.name || null]));
  return {
    order_code: row.order_code || row.code,
    status: row.status,
    created_date: row.created_date,
    order_date: row.order_date,
    current_warehouse_id: row.current_warehouse_id,
    current_warehouse_name: row.current_warehouse_name,
    pick_warehouse_id: row.pick_warehouse_id,
    deliver_warehouse_id: row.deliver_warehouse_id,
    end_pick_time: row.end_pick_time,
    end_delivery_time: row.end_delivery_time,
    end_success_time: row.end_success_time,
    warehouse_log: warehouseLog,
    warehouse_names: warehouseNames,
  };
});
console.log(JSON.stringify({ snapshotUpdatedAt: updatedAt, matched: results.length, results }, null, 2));
