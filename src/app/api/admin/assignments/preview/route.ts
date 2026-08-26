import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { authorizeApiRequest } from "@/security/api-security";
import current from "@/data/warehouse-assignments.generated.json";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const normalized = (value: unknown) => String(value ?? "").trim();
export async function POST(request: NextRequest) {
  const auth = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 10, windowMs: 60_000 });
  if (!auth.ok) return auth.response;
  const file = (await request.formData()).get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "XLSX_FILE_REQUIRED" }, { status: 400 });
  if (file.size > 8_000_000) return NextResponse.json({ error: "FILE_TOO_LARGE" }, { status: 413 });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await file.arrayBuffer()) as never);
  const sheet = workbook.getWorksheet("Phân công");
  if (!sheet) return NextResponse.json({ error: "ASSIGNMENT_SHEET_NOT_FOUND" }, { status: 400 });
  const header = new Map<string, number>(); sheet.getRow(1).eachCell((cell, column) => header.set(normalized(cell.value), column));
  const required = ["Mã kho", "Tên kho", "Zone", "Cấp 1 NVXL", "Cấp 2 Teamlead", "Cấp 3 Manager"];
  const missingColumns = required.filter((name) => !header.has(name));
  if (missingColumns.length) return NextResponse.json({ error: "MISSING_COLUMNS", missingColumns }, { status: 400 });
  const rows = new Map<string, { zone: string; manager: string }>(); const duplicateIds: string[] = [];
  for (let index = 2; index <= sheet.rowCount; index += 1) { const row = sheet.getRow(index); const get = (name: string) => normalized(row.getCell(header.get(name)!).value); const id = get("Mã kho"); if (!id) continue; if (rows.has(id)) duplicateIds.push(id); rows.set(id, { zone: get("Zone").replace("Miên Bắc 4", "Miền Bắc 4"), manager: get("Cấp 3 Manager") }); }
  const currentIds = new Set(current.warehouses.map((item) => item.warehouseId)); const uploadedIds = new Set(rows.keys());
  const added = [...uploadedIds].filter((id) => !currentIds.has(id)); const removed = [...currentIds].filter((id) => !uploadedIds.has(id)); const noManager = [...rows].filter(([, row]) => !row.manager).map(([id]) => id); const zones = [...new Set([...rows.values()].map((row) => row.zone).filter(Boolean))].sort();
  return NextResponse.json({ ok: true, previewOnly: true, fileName: file.name, summary: { rows: rows.size, zones: zones.length, added: added.length, removed: removed.length, duplicates: new Set(duplicateIds).size, missingManager: noManager.length }, zones, samples: { added: added.slice(0, 20), removed: removed.slice(0, 20), duplicates: [...new Set(duplicateIds)].slice(0, 20), missingManager: noManager.slice(0, 20) }, message: "Đây là preview; dữ liệu production chưa bị thay đổi." });
}
