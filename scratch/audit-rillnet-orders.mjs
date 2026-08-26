import { gunzipSync } from "node:zlib";

const wanted = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ["GY8K9UQ9", "GY847CLM_CPTT"]);
const endpoint = process.env.RILLNET_API_ENDPOINT || "https://rillnet-app.vercel.app/api/gtalk-send";
const metaEndpoint = process.env.RILLNET_META_ENDPOINT || "https://rillnet-app.vercel.app/wh_meta.json";
const snapshotResponse = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "opssnap" }) });
if (!snapshotResponse.ok) throw new Error(`Snapshot URL HTTP ${snapshotResponse.status}`);
const snapshotInfo = await snapshotResponse.json();
const downloadUrl = new URL(snapshotInfo.liveUrl || snapshotInfo.url, endpoint).toString();
const downloadResponse = await fetch(downloadUrl);
if (!downloadResponse.ok) throw new Error(`Snapshot download HTTP ${downloadResponse.status}`);
const compressed = Buffer.from(await downloadResponse.arrayBuffer());
let text;
try { text = gunzipSync(compressed).toString("utf8"); } catch { text = compressed.toString("utf8"); }
const rows = JSON.parse(text).filter((row) => wanted.has(String(row.order_code || row.code || "")));
const metaResponse = await fetch(metaEndpoint);
const meta = metaResponse.ok ? await metaResponse.json() : {};
const results = rows.map((row) => {
  let warehouseLog = row.warehouse_log;
  if (typeof warehouseLog === "string") { try { warehouseLog = JSON.parse(warehouseLog); } catch {} }
  const ids = [row.current_warehouse_id, row.pick_warehouse_id, row.deliver_warehouse_id, ...(Array.isArray(warehouseLog) ? warehouseLog.map((item) => item?.current_warehouse_id ?? item?.warehouse_id) : [])].filter((id) => id != null && String(id) !== "");
  const warehouseNames = Object.fromEntries(ids.map((id) => [String(id), meta[String(id)]?.n || meta[String(id)]?.name || null]));
  return { order_code: row.order_code || row.code, status: row.status, client_id: row.client_id, client_name: row.client_name, customer_id: row.customer_id, customer_name: row.customer_name, shop_id: row.shop_id, shop_name: row.shop_name, client_order_code: row.client_order_code, created_date: row.created_date, order_date: row.order_date, current_warehouse_id: row.current_warehouse_id, current_warehouse_name: row.current_warehouse_name, pick_warehouse_id: row.pick_warehouse_id, deliver_warehouse_id: row.deliver_warehouse_id, end_pick_time: row.end_pick_time, end_delivery_time: row.end_delivery_time, end_success_time: row.end_success_time, warehouse_log: warehouseLog, warehouse_names: warehouseNames };
});
console.log(JSON.stringify({ snapshotUpdatedAt: snapshotInfo.liveUpdated || snapshotInfo.updated, matched: results.length, results }, null, 2));
