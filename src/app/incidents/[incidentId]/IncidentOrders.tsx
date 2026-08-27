"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, BrainCircuit, ChevronDown, ChevronUp, ExternalLink, LoaderCircle } from "lucide-react";
import { validJourneyTime, type IncidentOrderJourneySource } from "./orderJourney";
import { bridgeErrorMessage, cacheBridgeTracking, LiveOrderJourney, requestThroughReadyBridge, waitForBridge, type ApiData } from "./LiveOrderJourney";
import type { LiveOrderTracking } from "@/connectors/ghn-order-tracking";
import { diagnoseOperationalJourney, groupOperationalDiagnoses } from "@/domain/operational-learning/root-cause-playbook";
import { PlaybookGapReview } from "./PlaybookGapReview";

const sleep = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const RETRYABLE_GHN_ERRORS = new Set(["GHN_RATE_LIMITED", "GHN_UPSTREAM_ERROR", "GHN_NETWORK_ERROR", "GHN_TIMEOUT", "BRIDGE_TIMEOUT"]);
const isRetryableGhnError = (code: string) => RETRYABLE_GHN_ERRORS.has(code) || (code.startsWith("GHN_HTTP_") && Number(code.slice("GHN_HTTP_".length)) >= 500);
const MAX_GHN_BATCH_CONCURRENCY = 2;

function playbookGapRequirement(tracking?: LiveOrderTracking) {
  if (!tracking) return "Thiếu dữ liệu timeline trực tiếp để xác định quy tắc cần bổ sung.";
  const deliveredAt = tracking.endSuccessAt || tracking.endDeliveryAt;
  if (deliveredAt) return `Đã giao thành công lúc ${new Date(deliveredAt).toLocaleString("vi-VN")}. Cần chốt SLA tối đa từ lúc bắt đầu giao đến giao thành công và cách xử lý các lần giao thất bại để kết luận chậm giao cuối.`;
  if (tracking.phase === "DELIVERING") return `Đơn bắt đầu giao lúc ${tracking.deliveryStartedAt ? new Date(tracking.deliveryStartedAt).toLocaleString("vi-VN") : "chưa lấy được timestamp"}. Cần chốt SLA đơn được phép ở trạng thái đang giao bao lâu trước khi tính là chậm.`;
  return "Timeline đã có nhưng chưa khớp rule hiện hành. Cần cung cấp ngưỡng thời gian, kho chịu trách nhiệm và action chuẩn cho trạng thái này.";
}

function incidentGapRootCause(tracking: LiveOrderTracking) {
  const deliveredAt = tracking.endSuccessAt || tracking.endDeliveryAt;
  if (deliveredAt) return `Đơn đã giao lúc ${new Date(deliveredAt).toLocaleString("vi-VN")} nhưng vẫn nằm trong incident: được xem là đã giao trễ so với SLA/cửa sổ kỳ vọng. Cần đối soát thời điểm nhập kho cuối, gán giao và giao thành công để xác định chặng gây trễ.`;
  if (tracking.phase === "IN_TRANSIT") return `Đơn đang trung chuyển nhưng đã nằm trong incident: thời gian chặng hoặc mốc COT đã vượt ngưỡng kỳ vọng. Cần đối soát log xuất kho, chuyến xe và thời điểm nhập kho kế tiếp để xác định chặng gây trễ.`;
  return "Đơn xuất hiện trong incident nhưng chưa khớp playbook hiện hành; cần đối soát timeline đầy đủ để xác định chặng và nguyên nhân gây trễ.";
}

async function requestThroughBridgeWithBackoff(orderCode: string) {
  const delays = [0, 1_500, 3_500];
  let lastError: unknown;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await sleep(delays[attempt]);
    try { return await requestThroughReadyBridge(orderCode); }
    catch (reason) {
      lastError = reason;
      const code = reason instanceof Error ? reason.message : "GHN_BRIDGE_ERROR";
      if (!isRetryableGhnError(code)) throw reason;
    }
  }
  throw lastError;
}

async function loadCachedTracking(incidentId: string, orderCode: string): Promise<ApiData | null> {
  try {
    const response = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/orders/${encodeURIComponent(orderCode)}/live-status?cache=only`, { cache: "no-store" });
    if (!response.ok) return null;
    return await response.json() as ApiData;
  } catch {
    return null;
  }
}

export type OperationalRollup = { analyzedCount: number; gapCount: number; groups: Array<{ key: string; title: string; warehouseName: string; orderCount: number; orderCodes: string[]; evidence: string; action: string }> };

export function IncidentOrders({ incidentId, onAnalysisChange }: { incidentId: string; onAnalysisChange?: (rollup: OperationalRollup) => void }) {
  const [data, setData] = useState<any>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [expandedGroupOrders, setExpandedGroupOrders] = useState<Set<string>>(new Set());
  const [expandedUnresolvedOrders, setExpandedUnresolvedOrders] = useState<Set<string>>(new Set());
  const [expandedUncoveredOrders, setExpandedUncoveredOrders] = useState<Set<string>>(new Set());
  const [liveOrders, setLiveOrders] = useState<Record<string, LiveOrderTracking>>({});
  const [batchState, setBatchState] = useState({ running: false, completed: 0, total: 0, failed: 0, error: "", errorCode: "" });
  const automaticAnalysisKey = useRef("");
  const attachRillnetCustomer = useCallback((tracking: LiveOrderTracking, order: IncidentOrderJourneySource): LiveOrderTracking => ({ ...tracking, customerId: order.customer_id || tracking.customerId || null, customerName: order.customer_name || tracking.customerName || null, orderCreatedAt: order.order_created_at || tracking.orderCreatedAt || null, endPickAt: order.end_pick_at || tracking.endPickAt || null, endDeliveryAt: order.end_delivery_at || tracking.endDeliveryAt || null, endSuccessAt: order.end_success_at || tracking.endSuccessAt || null }), []);
  useEffect(() => { fetch(`/api/incidents/${encodeURIComponent(incidentId)}/orders?page=${page}&search=${encodeURIComponent(query)}`, { cache: "no-store" }).then((response) => response.json()).then(setData); }, [incidentId, page, query]);
  const toggleOrder = (code: string, setter: typeof setExpandedGroupOrders) => setter((current) => { const next = new Set(current); if (next.has(code)) next.delete(code); else next.add(code); return next; });
  const toggleGroup = (orderCodes: string[]) => setExpandedGroupOrders((current) => {
    const next = new Set(current);
    const isExpanded = orderCodes.some((code) => current.has(code));
    for (const code of orderCodes) {
      if (isExpanded) {
        next.delete(code);
        next.delete(`detail:${code}`);
      } else next.add(code);
    }
    return next;
  });
  const rememberLiveOrder = useCallback((tracking: LiveOrderTracking) => {
    const order = (data?.orders || []).find((candidate: IncidentOrderJourneySource) => candidate.order_code === tracking.orderCode);
    const resolved = order ? attachRillnetCustomer(tracking, order) : tracking;
    setLiveOrders((current) => ({ ...current, [resolved.orderCode]: resolved }));
    return resolved;
  }, [attachRillnetCustomer, data?.orders]);
  const diagnoses = Object.values(liveOrders).map((tracking) => diagnoseOperationalJourney(tracking));
  const groupedCases = groupOperationalDiagnoses(diagnoses).filter((group) => group.findings.length > 0);
  const uncoveredCases = diagnoses.filter((diagnosis) => diagnosis.findings.length === 0);
  const unresolvedOrders = ((data?.orders || []) as IncidentOrderJourneySource[]).filter((order) => !liveOrders[order.order_code]);

  useEffect(() => {
    if (!onAnalysisChange) return;
    const currentDiagnoses = Object.values(liveOrders).map((tracking) => diagnoseOperationalJourney(tracking));
    const aggregates = new Map<string, OperationalRollup["groups"][number]>();
    for (const diagnosis of currentDiagnoses) for (const finding of diagnosis.findings) {
      const key = `${finding.groupingKey || finding.code}|${finding.ownerWarehouseId}`;
      const existing = aggregates.get(key);
      if (existing) { existing.orderCodes.push(diagnosis.orderCode); existing.orderCount = existing.orderCodes.length; }
      else aggregates.set(key, { key, title: finding.title, warehouseName: finding.ownerWarehouseName, orderCount: 1, orderCodes: [diagnosis.orderCode], evidence: finding.evidence, action: finding.action });
    }
    onAnalysisChange({ analyzedCount: currentDiagnoses.length, gapCount: currentDiagnoses.filter((diagnosis) => diagnosis.findings.length === 0).length, groups: [...aggregates.values()].sort((a, b) => b.orderCount - a.orderCount) });
  }, [liveOrders, onAnalysisChange]);
  const analyzeAllOrders = useCallback(async (forceRefresh = false) => {
    let orders: IncidentOrderJourneySource[] = [];
    try {
      const firstResponse = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/orders?page=1&search=`, { cache: "no-store" });
      const first = await firstResponse.json();
      if (!firstResponse.ok) throw new Error("ORDER_LIST_UNAVAILABLE");
      orders = first.orders || [];
      const totalPages = Math.ceil(Number(first.pagination?.total || orders.length) / 25);
      for (let targetPage = 2; targetPage <= totalPages; targetPage += 1) {
        const response = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/orders?page=${targetPage}&search=`, { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error("ORDER_LIST_UNAVAILABLE");
        orders.push(...(payload.orders || []));
      }
      orders = [...new Map(orders.map((order) => [order.order_code, order])).values()];
    } catch {
      orders = (data?.orders || []) as IncidentOrderJourneySource[];
    }
    if (!orders.length) return;
    setBatchState({ running: true, completed: 0, total: orders.length, failed: 0, error: "", errorCode: "" });
    let completed = 0; let failed = 0; let stopped = false;
    let terminalError = ""; let terminalErrorCode = "";
    const repeatedErrors = new Map<string, number>();
    let nextOrderIndex = 0;
    let bridgeReady: Promise<void> | null = null;
    const ensureBridgeReady = () => {
      bridgeReady ||= waitForBridge();
      return bridgeReady;
    };
    const processOrder = async (order: IncidentOrderJourneySource) => {
      if (stopped) return;
      try {
        const cached = forceRefresh ? null : await loadCachedTracking(incidentId, order.order_code);
        if (!cached) await ensureBridgeReady();
        const source = cached || await requestThroughBridgeWithBackoff(order.order_code);
        const tracking = attachRillnetCustomer(source, order);
        setLiveOrders((current) => ({ ...current, [tracking.orderCode]: tracking }));
        if (!cached) void cacheBridgeTracking(incidentId, source);
      } catch (reason) {
        const code = reason instanceof Error ? reason.message : "GHN_BRIDGE_ERROR";
        failed += 1;
        const repeats = (repeatedErrors.get(code) || 0) + 1;
        repeatedErrors.set(code, repeats);
        if (["BRIDGE_UNAVAILABLE", "GHN_SESSION_NOT_FOUND", "GHN_SESSION_EXPIRED"].includes(code) || repeats >= 3) {
          stopped = true;
          terminalError = bridgeErrorMessage(code);
          terminalErrorCode = code;
        }
      } finally {
        completed += 1;
        setBatchState({ running: !stopped, completed, total: orders.length, failed, error: terminalError, errorCode: terminalErrorCode });
      }
    };
    const worker = async () => {
      while (!stopped) {
        const currentIndex = nextOrderIndex;
        nextOrderIndex += 1;
        if (currentIndex >= orders.length) return;
        await processOrder(orders[currentIndex]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_GHN_BATCH_CONCURRENCY, orders.length) }, worker));
    setBatchState({ running: false, completed, total: orders.length, failed, error: terminalError, errorCode: terminalErrorCode });
  }, [attachRillnetCustomer, data?.orders, incidentId]);

  useEffect(() => {
    if (!data?.orders?.length || batchState.running) return;
    const key = `${incidentId}:${data.oldestOrderCode || "no-oldest"}`;
    if (automaticAnalysisKey.current === key) return;
    automaticAnalysisKey.current = key;
    void analyzeAllOrders();
  }, [analyzeAllOrders, batchState.running, data?.oldestOrderCode, data?.orders?.length, incidentId]);

  return <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
    <h2 className="text-lg font-bold">Danh sách đơn để kiểm chứng</h2>
    <p className="mt-1 text-sm leading-6 text-slate-400">Mở một đơn để kiểm tra trạng thái và lộ trình trực tiếp từ lịch sử vận hành GHN.</p>
    <label htmlFor="order-search" className="mt-3 block text-sm font-semibold">Tìm mã đơn</label>
    <input id="order-search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} className="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400" />
    <section className="mt-4 rounded-xl border border-cyan-800/70 bg-cyan-950/20 p-4"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><h3 className="font-bold text-cyan-100">Tự động phân tích và gom nhóm toàn bộ sự cố</h3><p className="mt-1 text-sm text-slate-400">Timeline và trạng thái lấy trực tiếp từ GHN; Khách hàng lấy từ Rillnet. Tối đa {MAX_GHN_BATCH_CONCURRENCY} tra cứu GHN đồng thời để tăng tốc mà vẫn giữ an toàn phiên.</p></div><button type="button" disabled={batchState.running || !(data?.orders?.length)} onClick={() => void analyzeAllOrders(true)} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-cyan-500 px-4 font-bold text-slate-950 disabled:cursor-wait disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300">{batchState.running ? <LoaderCircle aria-hidden="true" className="animate-spin" size={18}/> : <BrainCircuit aria-hidden="true" size={18}/>} {batchState.running ? `Đang tự phân tích ${batchState.completed}/${batchState.total}` : "Phân tích lại trực tiếp"}</button></div>{batchState.total > 0 && <div className="mt-3" aria-live="polite"><div className="h-2 overflow-hidden rounded-full bg-slate-800"><div className="h-full bg-cyan-400 transition-[width]" style={{ width: `${Math.round((batchState.completed / batchState.total) * 100)}%` }}/></div><p className="mt-2 text-xs text-slate-400">Đã xử lý {batchState.completed}/{batchState.total} đơn{batchState.failed ? ` · ${batchState.failed} lượt lỗi` : ""}. Lần tự chạy sẽ ưu tiên kết quả GHN đã lưu; nút này luôn tra cứu GHN mới.</p>{batchState.error && <div role="alert" className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100"><p className="font-semibold">Đã dừng vì lỗi hệ thống lặp lại · {batchState.errorCode}</p><p className="mt-1">{batchState.error} Hãy khắc phục kết nối rồi bấm Phân tích lại trực tiếp.</p></div>}</div>}</section>
    {groupedCases.length > 0 && <section className="mt-4 rounded-xl border border-violet-500/30 bg-violet-950/20 p-4" aria-labelledby="grouped-root-causes"><h3 id="grouped-root-causes" className="font-bold text-violet-100">Nhóm case giống nhau đã tra cứu</h3><p className="mt-1 text-sm text-slate-400">Mở nhóm để xem danh sách; chỉ đơn bạn bấm “Tra cứu lộ trình” mới gọi GHN.</p><div className="mt-3 space-y-2">{groupedCases.map((group) => { const groupExpanded = group.orderCodes.some((code) => expandedGroupOrders.has(code)); return <article key={group.key} className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950/70"><button type="button" onClick={() => toggleGroup(group.orderCodes)} aria-expanded={groupExpanded} className="flex min-h-11 w-full items-start justify-between gap-3 p-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-300"><span><span className="block font-semibold">{group.orderCodes.length} đơn · {group.customerName} · {group.orderType === "DOCUMENT_RETURN_CPTT" ? "Chứng từ CPTT" : "Đơn thường"}</span><span className="mt-2 block space-y-1 text-sm text-slate-300">{group.findings.map((finding) => <span key={`${finding.code}-${finding.ownerWarehouseId}`} className="block">{finding.title} — {finding.ownerWarehouseName}</span>)}</span></span>{groupExpanded ? <ChevronUp aria-hidden="true" className="shrink-0" size={18}/> : <ChevronDown aria-hidden="true" className="shrink-0" size={18}/>}</button>{groupExpanded && <div className="border-t border-slate-800">{group.orderCodes.map((orderCode) => { const tracking = liveOrders[orderCode]; const orderExpanded = expandedGroupOrders.has(`detail:${orderCode}`); return <div key={orderCode} className="border-b border-slate-800 last:border-0"><div className="grid items-center gap-2 p-3 text-sm md:grid-cols-[1.2fr_1fr_1.4fr_1fr_auto]"><a href={`https://tracuunoibo.ghn.vn/internal?order_code=${encodeURIComponent(orderCode)}&tab=order-history`} target="_blank" rel="noopener noreferrer" className="font-mono font-semibold text-cyan-300">{orderCode}</a><span>{tracking?.customerName || "—"}</span><span>{tracking?.currentWarehouseName || tracking?.nextWarehouseName || "Đang trên hành trình"}</span><span>{tracking?.statusLabel || "—"}</span><button type="button" onClick={() => toggleOrder(`detail:${orderCode}`, setExpandedGroupOrders)} aria-expanded={orderExpanded} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 font-semibold text-blue-300">Tra cứu lộ trình {orderExpanded ? <ChevronUp aria-hidden="true" size={15}/> : <ChevronDown aria-hidden="true" size={15}/>}</button></div>{orderExpanded && <div className="border-t border-slate-800 p-3"><LiveOrderJourney orderCode={orderCode} onResolved={rememberLiveOrder}/></div>}</div>; })}</div>}</article>; })}</div></section>}
    {uncoveredCases.length > 0 && <section className="mt-4 rounded-xl border border-amber-500/40 bg-amber-950/20 p-4" aria-labelledby="uncovered-root-causes"><div className="flex items-start gap-3"><AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0 text-amber-300" size={20}/><div><h3 id="uncovered-root-causes" className="font-bold text-amber-100">Sự cố chưa có trong Operations Playbook</h3><p className="mt-1 text-sm text-amber-200/70">Các đơn này đã có timeline nhưng chưa khớp quy tắc nào. Vì đã xuất hiện trong incident, hệ thống coi là có dấu hiệu trễ; bấm từng đơn để mở timeline và review.</p></div></div><div className="mt-3 space-y-2">{uncoveredCases.map((diagnosis) => { const tracking = liveOrders[diagnosis.orderCode]; const expanded = expandedUncoveredOrders.has(diagnosis.orderCode); return <article key={diagnosis.orderCode} className="rounded-lg border border-amber-500/20 bg-slate-950/70 p-3"><div className="flex items-start justify-between gap-3"><div><p className="font-mono font-semibold text-amber-200">{diagnosis.orderCode}</p><p className="mt-1 text-sm text-slate-300">{diagnosis.customerName} · {tracking?.currentWarehouseName || "Kho chưa xác định"} · {tracking?.statusLabel || "Trạng thái chưa xác định"}</p></div>{tracking && <button type="button" onClick={() => setExpandedUncoveredOrders((current) => { const next = new Set(current); if (next.has(diagnosis.orderCode)) next.delete(diagnosis.orderCode); else next.add(diagnosis.orderCode); return next; })} aria-expanded={expanded} className="min-h-11 shrink-0 rounded-lg border border-amber-400/40 px-3 text-sm font-semibold text-amber-100">{expanded ? "Thu gọn" : "Xem timeline & root-cause"}</button>}</div>{tracking && expanded && <><p className="mt-2 rounded-md border border-rose-400/20 bg-rose-400/5 p-3 text-sm leading-6 text-rose-100"><strong>Nguyên nhân cần xác minh:</strong> {incidentGapRootCause(tracking)}</p><div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3"><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Timeline trực tiếp GHN</p><LiveOrderJourney orderCode={tracking.orderCode} onResolved={rememberLiveOrder}/></div><PlaybookGapReview incidentId={incidentId} tracking={tracking}/></>}</article>; })}</div></section>}
    {unresolvedOrders.length > 0 && <><h3 className="mt-5 font-bold text-amber-100">Đơn chưa lấy được dữ liệu để phân tích</h3><div className="mt-2 overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="text-slate-400"><tr><th className="p-3">Mã đơn</th><th>Khách hàng</th><th>Kho hiện tại</th><th>Trạng thái</th><th>Tuổi</th><th>Ngày tạo</th><th><span className="sr-only">Thao tác</span></th></tr></thead><tbody>{unresolvedOrders.map((order: IncidentOrderJourneySource) => {
      const isExpanded = expandedUnresolvedOrders.has(order.order_code);
      const live = liveOrders[order.order_code];
      return <Fragment key={order.order_code}><tr className="border-t border-slate-800"><td className="p-3"><a href={`https://tracuunoibo.ghn.vn/internal?order_code=${encodeURIComponent(order.order_code)}&tab=order-history`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-md font-mono font-semibold text-cyan-300 hover:text-cyan-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400">{order.order_code}<ExternalLink aria-hidden="true" size={15}/></a>{order.order_code === data.oldestOrderCode && <span className="ml-2 rounded bg-amber-500/20 px-2 py-1 text-xs text-amber-200">Lâu nhất</span>}</td><td className={order.customer_name ? "text-slate-200" : "text-slate-500"}>{order.customer_name || "Rillnet chưa có dữ liệu"}</td><td className={live ? "text-slate-200" : "text-slate-500"}>{live?.currentWarehouseName || "Tra cứu khi mở"}</td><td className={live ? "text-slate-200" : "text-slate-500"}>{live?.statusLabel || "Chưa tra cứu trực tiếp"}</td><td>{order.age_hours ?? "—"} giờ</td><td>{validJourneyTime(order.order_created_at) ? new Date(order.order_created_at).toLocaleString("vi-VN") : "—"}</td><td className="text-right"><button type="button" onClick={() => toggleOrder(order.order_code, setExpandedUnresolvedOrders)} aria-expanded={isExpanded} aria-controls={`journey-${order.order_code}`} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-3 font-semibold text-blue-300 hover:bg-blue-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400">Trạng thái trực tiếp {isExpanded ? <ChevronUp aria-hidden="true" size={16}/> : <ChevronDown aria-hidden="true" size={16}/>}</button></td></tr>{isExpanded && <tr id={`journey-${order.order_code}`} className="border-t border-slate-800 bg-slate-950/50"><td colSpan={7} className="p-4"><h3 className="mb-4 font-semibold">Kiểm chứng đơn {order.order_code}</h3><LiveOrderJourney orderCode={order.order_code} onResolved={rememberLiveOrder}/></td></tr>}</Fragment>;
    })}</tbody></table></div>
    <div className="mt-3 flex items-center justify-between"><span>{unresolvedOrders.length} đơn chưa phân tích trên trang này</span><div className="flex gap-2"><button disabled={page === 1} onClick={() => setPage((value) => value - 1)} className="min-h-11 rounded border border-slate-700 px-3 disabled:opacity-40">Trước</button><button disabled={page * 25 >= (data?.pagination?.total || 0)} onClick={() => setPage((value) => value + 1)} className="min-h-11 rounded border border-slate-700 px-3 disabled:opacity-40">Sau</button></div></div></>}
  </section>;
}
