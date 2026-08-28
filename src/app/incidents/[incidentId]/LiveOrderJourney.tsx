"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, BrainCircuit, Check, Circle, LoaderCircle, MapPin, RefreshCw, Truck } from "lucide-react";
import type { LiveOrderTracking } from "@/connectors/ghn-order-tracking";
import { diagnoseOperationalJourney, OPERATIONAL_PLAYBOOK_VERSION } from "@/domain/operational-learning/root-cause-playbook";
import { PlaybookGapReview } from "./PlaybookGapReview";

export type ApiData = LiveOrderTracking & { ok: true; source: string; savedAt?: string };

const formatTime = (value: string | null | undefined) => value ? new Date(value).toLocaleString("vi-VN") : "—";

export function waitForBridge() {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => { window.removeEventListener("GHN_BRIDGE_READY", ready); reject(new Error("BRIDGE_UNAVAILABLE")); }, 700);
    const ready = () => { window.clearTimeout(timer); window.removeEventListener("GHN_BRIDGE_READY", ready); resolve(); };
    window.addEventListener("GHN_BRIDGE_READY", ready, { once: true });
    window.dispatchEvent(new CustomEvent("GHN_BRIDGE_PING"));
  });
}

export function requestThroughReadyBridge(orderCode: string): Promise<ApiData> {
  return new Promise<ApiData>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const eventName = `GHN_ORDER_TRACKING_RESPONSE_${requestId}`;
    const timer = window.setTimeout(() => { window.removeEventListener(eventName, receive as EventListener); reject(new Error("BRIDGE_TIMEOUT")); }, 12_000);
    const receive = (event: Event) => {
      window.clearTimeout(timer);
      window.removeEventListener(eventName, receive as EventListener);
      const detail = (event as CustomEvent).detail;
      if (detail?.error) reject(new Error(String(detail.error)));
      else resolve(detail as ApiData);
    };
    window.addEventListener(eventName, receive as EventListener, { once: true });
    window.dispatchEvent(new CustomEvent("GHN_ORDER_TRACKING_REQUEST", { detail: { requestId, orderCode } }));
  });
}

export async function requestThroughBridge(orderCode: string): Promise<ApiData> {
  await waitForBridge();
  return requestThroughReadyBridge(orderCode);
}

export function cacheBridgeTracking(incidentId: string, tracking: ApiData) {
  const { recipientName: _recipientName, recipientAddress: _recipientAddress, ...safeToCache } = tracking;
  return fetch(`/api/incidents/${encodeURIComponent(incidentId)}/orders/${encodeURIComponent(tracking.orderCode)}/live-status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(safeToCache),
  });
}

export function bridgeErrorMessage(code: string) {
  if (code === "BRIDGE_UNAVAILABLE") return "Chưa cài hoặc chưa bật OpsPilot GHN Tracking Bridge trong Tampermonkey.";
  if (code === "GHN_SESSION_NOT_FOUND") return "Chưa bắt được phiên GHN. Hãy mở hoặc tải lại trang Tra cứu nội bộ GHN rồi thử lại.";
  if (code === "GHN_SESSION_EXPIRED") return "Phiên GHN đã hết hạn. Hãy đăng nhập lại trang Tra cứu nội bộ GHN.";
  if (code === "BRIDGE_TIMEOUT" || code === "GHN_TIMEOUT") return "GHN phản hồi quá lâu. Vui lòng thử lại.";
  if (code === "GHN_UPSTREAM_ERROR") return "API Tra cứu nội bộ GHN đang từ chối hoặc không trả được dữ liệu cho phiên hiện tại.";
  if (code === "GHN_RATE_LIMITED") return "GHN đang giới hạn tần suất tra cứu. Hệ thống đã tự chờ và thử lại nhưng vẫn chưa được chấp nhận.";
  if (code.startsWith("GHN_HTTP_")) return `API GHN trả về HTTP ${code.slice("GHN_HTTP_".length)}.`;
  if (code === "GHN_INVALID_RESPONSE") return "API GHN trả về dữ liệu không đúng định dạng mong đợi.";
  if (code === "GHN_NETWORK_ERROR") return "Bridge không kết nối được tới API GHN.";
  return "Không thể lấy trạng thái trực tiếp từ GHN.";
}

export function LiveOrderJourney({ orderCode, onResolved }: { orderCode: string; onResolved?: (data: ApiData) => LiveOrderTracking | void }) {
  const [data, setData] = useState<ApiData | null>(null);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setErrorCode("");
    try {
      const incidentId = window.location.pathname.split("/").filter(Boolean)[1] || "";
      let payload: ApiData;
      try {
        payload = await requestThroughBridge(orderCode);
        void cacheBridgeTracking(incidentId, payload);
      } catch (bridgeError) {
        const response = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/orders/${encodeURIComponent(orderCode)}/live-status`, { cache: "no-store" });
        if (!response.ok) throw bridgeError;
        payload = await response.json();
      }
      const resolved = onResolved?.(payload);
      setData((resolved || payload) as ApiData);
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : "GHN_BRIDGE_ERROR";
      setErrorCode(code);
      setError(bridgeErrorMessage(code));
    } finally {
      setLoading(false);
    }
  }, [orderCode, onResolved]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (loading && !data) return <div aria-busy="true" aria-live="polite" className="flex min-h-40 items-center justify-center gap-3 rounded-xl border border-cyan-900/60 bg-cyan-950/20 text-cyan-200"><LoaderCircle aria-hidden="true" className="animate-spin" size={20}/><span>Đang kiểm tra trực tiếp trên GHN…</span></div>;
  if (error && !data) return <div role="alert" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-amber-100"><div className="flex gap-3"><AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={20}/><div><p className="font-semibold">Không thể xác minh trạng thái trực tiếp</p><p className="mt-1 text-sm text-amber-200/80">{error}</p><div className="mt-3 flex flex-wrap gap-2">{errorCode === "BRIDGE_UNAVAILABLE" && <a href="/ghn-bridge.user.js" className="inline-flex min-h-11 items-center rounded-lg bg-amber-300 px-3 font-bold text-slate-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-100">Cài Tampermonkey Bridge</a>}<button type="button" onClick={() => void load()} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-amber-400/40 px-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300"><RefreshCw aria-hidden="true" size={16}/>Thử lại</button>{errorCode === "GHN_SESSION_NOT_FOUND" && <a href="https://tracuunoibo.ghn.vn/" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-lg border border-amber-400/40 px-3 font-semibold">Mở trang GHN</a>}</div></div></div></div>;
  if (!data) return null;

  const inTransit = data.phase === "IN_TRANSIT";
  const finalDestinationPending = Boolean(data.deliverWarehouseId && data.deliverWarehouseId !== data.currentWarehouseId && !data.journey.some((point) => point.warehouseId === data.deliverWarehouseId));
  const finalDestinationLabel = data.deliverWarehouseType === "Bưu cục" ? "BƯU CỤC GIAO CUỐI" : "KHO GIAO CUỐI";
  const savedCopy = data.source === "saved_bridge_tracking";
  const diagnosis = diagnoseOperationalJourney(data);
  const incidentId = window.location.pathname.split("/").filter(Boolean)[1] || "";
  const findingGroups = [...diagnosis.findings.reduce((groups, finding) => {
    const key = finding.ownerWarehouseId;
    const current = groups.get(key);
    if (current) current.findings.push(finding);
    else groups.set(key, { ownerWarehouseName: finding.ownerWarehouseName, findings: [finding] });
    return groups;
  }, new Map<string, { ownerWarehouseName: string; findings: typeof diagnosis.findings }>()).values()];
  return <div aria-busy={loading} className="space-y-5">
    {savedCopy && <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">Bản đã lưu từ máy tính lúc {formatTime(data.savedAt || data.checkedAt)}. Muốn cập nhật mới, hãy mở đơn này trên máy tính có Bridge.</p>}
    <div className="flex flex-col justify-between gap-4 rounded-xl border border-cyan-800/70 bg-cyan-950/20 p-4 sm:flex-row sm:items-start">
      <div><p className="text-xs font-bold uppercase tracking-[.14em] text-cyan-300">Trạng thái trực tiếp GHN · Bridge đã kết nối</p><p className="mt-2 text-xl font-bold text-white">{data.statusLabel}</p>{inTransit ? <p className="mt-1 text-sm text-slate-300">{data.currentWarehouseName || "Kho xuất phát"} → {data.nextWarehouseName || "Kho tiếp theo chưa xác định"}</p> : <p className="mt-1 text-sm text-slate-300">{data.currentWarehouseName || "Kho chưa xác định"}{data.currentWarehouseId ? ` · ${data.currentWarehouseId}` : ""}</p>}<p className="mt-1 text-sm text-violet-200">Khách hàng: {diagnosis.customerName} · {diagnosis.orderType === "DOCUMENT_RETURN_CPTT" ? "Chứng từ thu hồi CPTT" : "Đơn thường"}</p><p className="mt-2 text-xs text-slate-400">Sự kiện mới nhất: {formatTime(data.lastEventAt)} · Kiểm tra lúc {formatTime(data.checkedAt)}</p></div>
      <button type="button" disabled={loading} onClick={() => void load()} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg border border-cyan-700 px-3 font-semibold text-cyan-200 hover:bg-cyan-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 disabled:opacity-50"><RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} size={16}/>Làm mới</button>
    </div>
    {data.deliverWarehouseId && <dl className="grid gap-3 rounded-xl border border-indigo-500/30 bg-indigo-950/20 p-4 text-sm sm:grid-cols-2"><div><dt className="text-slate-400">Kho đang giữ đơn</dt><dd className="mt-1 font-semibold text-cyan-100">{data.currentWarehouseName || `Kho ${data.currentWarehouseId || "chưa xác định"}`}</dd></div><div><dt className="text-slate-400">Kho giao cuối theo GHN</dt><dd className="mt-1 font-semibold text-indigo-100">{data.deliverWarehouseId} · {data.deliverWarehouseName || "Chưa xác định tên kho"}</dd><p className="mt-1 text-xs text-slate-400">{data.deliverWarehouseType ? `Loại kho: ${data.deliverWarehouseType}` : "Chưa xác định loại kho"}{data.currentWarehouseId && data.currentWarehouseId !== data.deliverWarehouseId ? " · chưa có log xác nhận đã xuất từ kho đang giữ" : ""}</p></div></dl>}
    {error && <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">Lần làm mới gần nhất thất bại. Đang hiển thị kết quả kiểm tra lúc {formatTime(data.checkedAt)}.</p>}
    <div className="overflow-x-auto pb-3">
      <ol aria-label={`Lộ trình trực tiếp của đơn ${orderCode}`} className="flex min-w-max items-start px-4">
        {data.journey.map((point, index) => <li key={`${point.warehouseId}-${point.arrivedAt}`} className="relative w-56 px-3 text-center">{index > 0 && <span aria-hidden="true" className="absolute -left-1/2 top-4 h-0.5 w-full bg-emerald-500"/>}<span className={`relative z-10 mx-auto flex h-8 w-8 items-center justify-center rounded-full border-2 ${point.current ? "border-cyan-300 bg-cyan-500 text-slate-950 ring-4 ring-cyan-400/20" : "border-emerald-400 bg-emerald-500 text-slate-950"}`}>{point.current ? <Circle aria-hidden="true" size={13} fill="currentColor"/> : <Check aria-hidden="true" size={18} strokeWidth={3}/>}</span><p className="mt-3 font-semibold text-slate-100">{point.warehouseName}</p><p className="mt-1 font-mono text-[11px] text-slate-500">{point.warehouseId}</p><time dateTime={point.arrivedAt} className="mt-1 block font-mono text-[11px] text-cyan-200">Nhập: {formatTime(point.arrivedAt)}</time>{point.departedAt && <time dateTime={point.departedAt} className="mt-1 block font-mono text-[11px] text-slate-400">Xuất: {formatTime(point.departedAt)}</time>}{point.current && <span className="mt-2 inline-block rounded-full bg-cyan-500/10 px-2 py-1 text-[10px] font-bold text-cyan-300">ĐANG TẠI ĐÂY</span>}</li>)}
        {inTransit && <li className="relative w-56 px-3 text-center"><span aria-hidden="true" className="absolute -left-1/2 top-4 h-0.5 w-full bg-cyan-500"/><span className="relative z-10 mx-auto flex h-8 w-8 items-center justify-center rounded-full border-2 border-cyan-300 bg-slate-950 text-cyan-300 ring-4 ring-cyan-400/20"><Truck aria-hidden="true" size={16}/></span><p className="mt-3 font-semibold text-cyan-100">Đang trung chuyển</p><p className="mt-1 text-xs text-slate-400">Đến {data.nextWarehouseName || "kho tiếp theo"}</p></li>}
        {finalDestinationPending && <li aria-label={`${finalDestinationLabel}: ${data.deliverWarehouseId} ${data.deliverWarehouseName || ""}, chưa đến`} className="relative w-56 px-3 text-center"><span aria-hidden="true" className="absolute -left-1/2 top-4 w-full border-t-2 border-dashed border-indigo-400/70"/><span className="relative z-10 mx-auto flex h-8 w-8 items-center justify-center rounded-full border-2 border-dashed border-indigo-300 bg-indigo-950 text-indigo-200 ring-4 ring-indigo-400/10"><MapPin aria-hidden="true" size={16}/></span><p className="mt-3 text-[10px] font-bold tracking-wide text-indigo-300">{finalDestinationLabel}</p><p className="mt-1 font-semibold text-indigo-100">{data.deliverWarehouseName || "Chưa xác định tên kho"}</p><p className="mt-1 font-mono text-[11px] text-indigo-300">{data.deliverWarehouseId}</p><span className="mt-2 inline-block rounded-full border border-indigo-400/30 bg-indigo-500/10 px-2 py-1 text-[10px] font-bold text-indigo-200">CHƯA ĐẾN</span></li>}
        {data.deliveryStartedAt && <li className="relative w-56 px-3 text-center"><span aria-hidden="true" className="absolute -left-1/2 top-4 h-0.5 w-full bg-cyan-500"/><span className="relative z-10 mx-auto flex h-8 w-8 items-center justify-center rounded-full border-2 border-cyan-300 bg-cyan-500 text-slate-950 ring-4 ring-cyan-400/20"><Truck aria-hidden="true" size={16}/></span><p className="mt-3 font-semibold text-cyan-100">Bắt đầu giao</p><time dateTime={data.deliveryStartedAt} className="mt-1 block font-mono text-[11px] text-cyan-200">{formatTime(data.deliveryStartedAt)}</time>{data.deliveryStartedAtInferred && <p className="mt-1 text-[10px] text-amber-200">Mốc suy ra từ log giao đầu tiên</p>}</li>}
        {(data.endSuccessAt || data.endDeliveryAt) && <li className="relative w-72 px-3 text-center"><span aria-hidden="true" className="absolute -left-1/2 top-4 h-0.5 w-full bg-emerald-500"/><span className="relative z-10 mx-auto flex h-8 w-8 items-center justify-center rounded-full border-2 border-emerald-400 bg-emerald-500 text-slate-950"><Check aria-hidden="true" size={18} strokeWidth={3}/></span><p className="mt-3 font-semibold text-emerald-100">Giao thành công</p><time dateTime={data.endSuccessAt || data.endDeliveryAt || undefined} className="mt-1 block font-mono text-[11px] text-emerald-200">{formatTime(data.endSuccessAt || data.endDeliveryAt)}</time>{data.recipientName && <p className="mt-2 text-sm font-semibold text-slate-100">{data.recipientName}</p>}{data.recipientAddress && <p className="mt-1 text-xs leading-5 text-slate-300">{data.recipientAddress}</p>}</li>}
      </ol>
    </div>
    <section className="rounded-xl border border-violet-500/30 bg-violet-950/20 p-4" aria-labelledby={`ai-diagnosis-${orderCode}`}><div className="flex items-start gap-3"><BrainCircuit aria-hidden="true" className="mt-0.5 shrink-0 text-violet-300" size={20}/><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><h4 id={`ai-diagnosis-${orderCode}`} className="font-bold text-violet-100">Chẩn đoán theo tri thức vận hành</h4><span className="font-mono text-[10px] text-slate-500">Playbook {OPERATIONAL_PLAYBOOK_VERSION}</span></div>{findingGroups.length ? <ol className="mt-4 space-y-3">{findingGroups.map((group) => <li key={group.ownerWarehouseName} className="rounded-lg border border-slate-800 bg-slate-950/70 p-3"><p className="font-semibold text-rose-200">Nguyên nhân vận hành tại {group.ownerWarehouseName}</p><ul className="mt-2 space-y-2">{group.findings.map((finding) => <li key={finding.code}><p className="text-sm font-semibold text-slate-100">{finding.title}</p><p className="mt-1 text-sm leading-6 text-slate-300">{finding.evidence}</p></li>)}</ul><ol className="mt-3 space-y-2 border-t border-slate-800 pt-3">{group.findings.map((finding, index) => <li key={`action-${finding.code}`} className="text-sm font-semibold leading-6 text-emerald-200">Action {index + 1}: {finding.action}</li>)}</ol><p className="mt-2 font-mono text-[10px] text-slate-600">{group.findings.map((finding) => finding.code).join(" + ")}</p><PlaybookGapReview incidentId={incidentId} tracking={data} mode="supplement"/></li>)}</ol> : <p className="mt-3 text-sm text-slate-400">Chưa có quy tắc nào đủ bằng chứng để kết luận lỗi cho hành trình này.</p>}</div></div></section>
  </div>;
}
