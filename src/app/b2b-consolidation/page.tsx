"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, CalendarClock, Plus, RefreshCw, ShieldCheck, Truck, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { roleCan, roleFromMetadata, type OpsRole } from "@/security/roles";
import { handleApiAccess } from "@/app/_components/apiAccess";
import type { ConsolidationAnalysis, ConsolidationOrder, ConsolidationTrip } from "@/domain/b2b-consolidation";

type Run = { id: string; created_by: string; verdict: ConsolidationAnalysis["verdict"]; trip: ConsolidationTrip; orders: ConsolidationOrder[]; result: ConsolidationAnalysis; created_at: string };

function localDateTime(hoursFromNow = 0) {
  const date = new Date(Date.now() + hoursFromNow * 3_600_000);
  date.setMinutes(0, 0, 0);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function blankOrder(index: number): ConsolidationOrder {
  return { orderCode: `B2B-${index}`, readyAt: localDateTime(0), latestSafeDepartureAt: localDateTime(4), weightKg: null, volumeM3: null };
}

function numericOrNull(value: string) { return value.trim() === "" ? null : Number(value); }
function readableTime(value: string | null | undefined) { return value ? new Date(value).toLocaleString("vi-VN") : "—"; }
function verdictStyle(value: ConsolidationAnalysis["verdict"]) {
  if (value === "ELIGIBLE_SHADOW") return "border-emerald-400/40 bg-emerald-400/10 text-emerald-200";
  if (value === "DISPATCH_NOW") return "border-amber-400/40 bg-amber-400/10 text-amber-100";
  return "border-rose-400/40 bg-rose-400/10 text-rose-100";
}

export default function B2bConsolidationPage() {
  const [actor, setActor] = useState("");
  const [role, setRole] = useState<OpsRole>("OPERATOR");
  const [trip, setTrip] = useState<ConsolidationTrip>({ tripId: "", originWarehouse: "", destinationWarehouse: "", departureAt: localDateTime(4), capacityKg: null, bookedKg: null, capacityM3: null, bookedM3: null });
  const [orders, setOrders] = useState<ConsolidationOrder[]>([blankOrder(1), blankOrder(2)]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [result, setResult] = useState<ConsolidationAnalysis | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const canManage = roleCan(role, "MANAGE_DECISION");
  const capacityKnown = useMemo(() => (trip.capacityKg !== null && trip.bookedKg !== null && orders.every((order) => order.weightKg !== null)) || (trip.capacityM3 !== null && trip.bookedM3 !== null && orders.every((order) => order.volumeM3 !== null)), [orders, trip]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/b2b-consolidation", { cache: "no-store" });
      const payload = await response.json();
      handleApiAccess(response, payload, "Không thể tải lịch sử ghép chuyến.");
      setRuns(payload.data || []);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const supabase = createClient();
    void supabase.auth.getUser().then(({ data }) => {
      if (!data.user) return;
      setActor(data.user.email || data.user.id);
      setRole(roleFromMetadata(data.user.app_metadata, data.user.user_metadata));
    });
  }, []);

  function updateOrder(index: number, patch: Partial<ConsolidationOrder>) {
    setOrders((current) => current.map((order, currentIndex) => currentIndex === index ? { ...order, ...patch } : order));
  }

  async function analyze() {
    if (!canManage) { setError("Chỉ Manager hoặc Admin được tạo đề xuất ghép chuyến SHADOW."); return; }
    if (!actor || !trip.tripId.trim() || !trip.originWarehouse.trim() || !trip.destinationWarehouse.trim() || orders.length < 2) { setError("Nhập mã chuyến, hai đầu tuyến và tối thiểu 2 đơn B2B."); return; }
    setSaving(true); setError("");
    try {
      const normalizedTrip = { ...trip, departureAt: new Date(trip.departureAt).toISOString() };
      const normalizedOrders = orders.map((order) => ({ ...order, readyAt: new Date(order.readyAt).toISOString(), latestSafeDepartureAt: new Date(order.latestSafeDepartureAt).toISOString() }));
      const response = await fetch("/api/b2b-consolidation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actor, idempotencyKey: `b2b-consolidation:${crypto.randomUUID()}`, trip: normalizedTrip, orders: normalizedOrders }) });
      const payload = await response.json();
      handleApiAccess(response, payload, "Không thể lưu đề xuất ghép chuyến.");
      setResult(payload.data.result);
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSaving(false); }
  }

  return <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-6">
      <div><p className="text-xs font-bold uppercase tracking-[.2em] text-teal-300">LC-11 · B2B CONSOLIDATION SHADOW</p><h1 className="mt-2 text-3xl font-bold tracking-tight text-white">Đề xuất ghép chuyến B2B</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">So sánh “xuất ngay” với “giữ để ghép chuyến” trước khi điều phối. OpsPilot không tự giữ đơn, không điều xe, không gửi Telegram và không ghi tiền tiết kiệm ở pha này.</p></div>
      <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-700 px-4 text-sm font-semibold text-slate-100 hover:bg-slate-900 disabled:opacity-60"><RefreshCw aria-hidden="true" size={16}/>{loading ? "Đang tải…" : "Làm mới"}</button>
    </div>
    {error && <p role="alert" className="mt-5 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-100">{error}</p>}
    <section className="mt-6 rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-5" aria-labelledby="safety-heading"><div className="flex gap-3"><ShieldCheck aria-hidden="true" className="mt-0.5 shrink-0 text-cyan-300" size={20}/><div><h2 id="safety-heading" className="font-semibold text-cyan-100">Safety gate bắt buộc</h2><p className="mt-1 text-sm leading-6 text-slate-300">Đề xuất chỉ khả dụng khi các đơn cùng tuyến, đã sẵn sàng, chuyến không vượt deadline SLA và còn năng lực. Financial impact luôn là <strong className="text-amber-200">NOT_EVALUATED</strong>; P15-B.1 vẫn là financial authority.</p></div></div></section>
    <section className="mt-6 rounded-xl border border-slate-800 bg-slate-900/60 p-5" aria-labelledby="trip-heading"><div className="flex items-center gap-2"><Truck aria-hidden="true" className="text-teal-300" size={20}/><h2 id="trip-heading" className="text-lg font-bold text-white">1. Chuyến dự kiến và năng lực</h2></div><p className="mt-1 text-sm text-slate-400">Đây là dữ liệu seed/manual cho pilot. Khi có API điều xe, adapter sẽ thay phần nhập này mà không đổi rule quyết định.</p>
      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[["Mã chuyến", "tripId", "text"], ["Kho xuất", "originWarehouse", "text"], ["Điểm đến/bưu cục", "destinationWarehouse", "text"], ["Giờ chuyến xuất", "departureAt", "datetime-local"]].map(([label, field, type]) => <label key={field} className="block text-sm font-semibold text-slate-200">{label}<input required type={type} value={String(trip[field as keyof ConsolidationTrip] ?? "")} onChange={(event) => setTrip((current) => ({ ...current, [field]: event.target.value }))} className="mt-1.5 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm font-normal text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"/></label>)}
        {[['Capacity kg', 'capacityKg'], ['Đã đặt kg', 'bookedKg'], ['Capacity m³', 'capacityM3'], ['Đã đặt m³', 'bookedM3']].map(([label, field]) => <label key={field} className="block text-sm font-semibold text-slate-200">{label}<input type="number" min="0" step="0.01" value={trip[field as keyof ConsolidationTrip] ?? ""} onChange={(event) => setTrip((current) => ({ ...current, [field]: numericOrNull(event.target.value) }))} className="mt-1.5 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm font-normal text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"/></label>)}
      </div>
    </section>
    <section className="mt-6 rounded-xl border border-slate-800 bg-slate-900/60 p-5" aria-labelledby="orders-heading"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="orders-heading" className="text-lg font-bold text-white">2. Các đơn B2B cần ghép</h2><p className="mt-1 text-sm text-slate-400">Deadline là thời điểm xuất muộn nhất đã được SLA/Owner xác thực, không phải SLA mặc định do AI đoán.</p></div><button type="button" onClick={() => setOrders((current) => [...current, blankOrder(current.length + 1)])} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-cyan-400/50 px-4 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/10"><Plus aria-hidden="true" size={16}/>Thêm đơn</button></div>
      <div className="mt-4 space-y-3">{orders.map((order, index) => <div key={`${index}-${order.orderCode}`} className="rounded-lg border border-slate-800 bg-slate-950/60 p-4"><div className="mb-3 flex items-center justify-between gap-3"><p className="font-semibold text-slate-100">Đơn {index + 1}</p>{orders.length > 2 && <button type="button" onClick={() => setOrders((current) => current.filter((_, currentIndex) => currentIndex !== index))} aria-label={`Bỏ đơn ${index + 1}`} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800"><X aria-hidden="true" size={16}/></button>}</div><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5"><label className="text-sm font-semibold text-slate-200">Mã đơn<input value={order.orderCode} onChange={(event) => updateOrder(index, { orderCode: event.target.value })} className="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm font-normal"/></label><label className="text-sm font-semibold text-slate-200">Sẵn sàng xuất<input type="datetime-local" value={order.readyAt} onChange={(event) => updateOrder(index, { readyAt: event.target.value })} className="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm font-normal"/></label><label className="text-sm font-semibold text-slate-200">Xuất muộn nhất (SLA)<input type="datetime-local" value={order.latestSafeDepartureAt} onChange={(event) => updateOrder(index, { latestSafeDepartureAt: event.target.value })} className="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm font-normal"/></label><label className="text-sm font-semibold text-slate-200">Khối lượng kg<input type="number" min="0" step="0.01" value={order.weightKg ?? ""} onChange={(event) => updateOrder(index, { weightKg: numericOrNull(event.target.value) })} className="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm font-normal"/></label><label className="text-sm font-semibold text-slate-200">Thể tích m³<input type="number" min="0" step="0.01" value={order.volumeM3 ?? ""} onChange={(event) => updateOrder(index, { volumeM3: numericOrNull(event.target.value) })} className="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm font-normal"/></label></div></div>)}</div>
      <div className={`mt-4 rounded-lg border p-3 text-sm ${capacityKnown ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-100" : "border-amber-500/30 bg-amber-500/5 text-amber-100"}`}><CalendarClock aria-hidden="true" className="mr-2 inline-block" size={16}/>{capacityKnown ? "Đã có dữ liệu capacity đủ để kiểm tra một chiều tải." : "Chưa đủ capacity/load; bấm phân tích chỉ có thể ra CẦN ĐIỀU TRA, không ra đề xuất giữ đơn."}</div>
      <button type="button" onClick={() => void analyze()} disabled={saving || !canManage} className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-lg bg-teal-500 px-5 text-sm font-bold text-slate-950 hover:bg-teal-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-200 disabled:cursor-not-allowed disabled:opacity-50"><ArrowRight aria-hidden="true" size={17}/>{saving ? "Đang phân tích…" : "Chạy phân tích SHADOW"}</button>{!canManage && <p className="mt-2 text-sm text-amber-200">Vai trò hiện tại không có quyền tạo đề xuất. Manager/Admin có thể chạy phân tích.</p>}
    </section>
    {result && <section className="mt-6 rounded-xl border border-violet-500/35 bg-violet-500/5 p-5" aria-live="polite"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-bold text-white">Kết quả SHADOW mới nhất</h2><span className={`rounded-full border px-3 py-1 text-xs font-bold ${verdictStyle(result.verdict)}`}>{result.verdict}</span></div><p className="mt-3 text-sm text-slate-300">Giữ đến tối đa: <strong>{readableTime(result.safeHoldUntil)}</strong> · Financial: <strong className="text-amber-200">NOT_EVALUATED</strong></p><div className="mt-4 grid gap-3 md:grid-cols-2">{result.options.map((option) => <div key={option.option} className="rounded-lg border border-slate-700 bg-slate-950/70 p-3"><p className="font-semibold text-slate-100">{option.option === "DISPATCH_NOW" ? "Xuất ngay" : "Giữ để ghép chuyến"}</p><p className="mt-1 text-sm text-slate-400">{option.description}</p><p className="mt-2 text-xs font-semibold text-cyan-200">{option.enabled ? "Có thể trình Manager review" : "Không đủ điều kiện"}{option.approvalRequired ? " · bắt buộc Manager duyệt" : ""}</p></div>)}</div>{result.reasonCodes.length > 1 || result.reasonCodes[0] !== "ELIGIBLE_FOR_MANAGER_REVIEW" ? <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-100"><AlertTriangle aria-hidden="true" className="mr-2 inline-block" size={16}/>{result.reasonCodes.join(" · ")}</div> : null}{result.requiredChecks.length ? <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-300">{result.requiredChecks.map((check) => <li key={check}>{check}</li>)}</ul> : null}</section>}
    <section className="mt-8"><h2 className="text-lg font-bold text-white">Lịch sử phân tích SHADOW</h2><p className="mt-1 text-sm text-slate-400">Audit bất biến; chưa có record nào tạo hành động vận hành hoặc financial outcome.</p><div className="mt-4 space-y-3">{runs.length ? runs.map((run) => <article key={run.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-semibold text-white">{run.trip.tripId} · {run.trip.originWarehouse} → {run.trip.destinationWarehouse}</p><p className="mt-1 text-sm text-slate-400">{run.orders.length} đơn · giờ chuyến {readableTime(run.trip.departureAt)} · tạo bởi {run.created_by}</p></div><span className={`rounded-full border px-3 py-1 text-xs font-bold ${verdictStyle(run.verdict)}`}>{run.verdict}</span></div><p className="mt-3 text-sm text-slate-300">Đơn: {run.orders.map((order) => order.orderCode).join(", ")} · Financial: <strong className="text-amber-200">NOT_EVALUATED</strong></p></article>) : <p className="rounded-xl border border-dashed border-slate-700 p-5 text-sm text-slate-400">Chưa có phân tích ghép chuyến nào được lưu.</p>}</div></section>
  </main>;
}
