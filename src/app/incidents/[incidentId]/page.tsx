"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Bot, BrainCircuit, ClipboardCheck, RefreshCw, ShieldAlert } from "lucide-react";
import { incidentRuleExplanation, incidentSignalLabel, repairOperationalText, translateStatus } from "@/app/_components/operationalText";
import { IncidentOrders, type OperationalRollup } from "./IncidentOrders";
import { PilotFeedbackForms } from "./PilotFeedbackForms";

type Json = Record<string, any>;

async function requestJson(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.message || payload.error || `Không thể tải ${url}`);
  return payload;
}

function reviewFingerprint(incidentId: string, rollup: OperationalRollup) {
  const source = `${incidentId}|${rollup.groups.map((group) => `${group.key}:${group.orderCount}`).join("|")}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
  return `operational-rollup:${incidentId}:${(hash >>> 0).toString(16)}`;
}

function OperationalReviewControl({ incidentId, warehouseId, rollup }: { incidentId: string; warehouseId?: string; rollup: OperationalRollup }) {
  const [submitting, setSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [decision, setDecision] = useState<Json | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const createReview = async () => {
    setSubmitting(true); setReviewError("");
    try {
      const fingerprint = reviewFingerprint(incidentId, rollup);
      const response = await fetch("/api/decisions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        sourceLinks: { incidentId, sourceType: "OPERATIONAL_ROLLUP", sourceId: incidentId }, sourceFingerprint: fingerprint, idempotencyKey: fingerprint,
        problem: `${rollup.analyzedCount} đơn được phân tích thành ${rollup.groups.length} hạng mục cần duyệt`,
        rootCause: rollup.groups.map((group) => `${group.title} — ${group.warehouseName} — ${group.orderCount} đơn`).join("\n"),
        recommendedAction: rollup.groups.map((group) => group.action).join("\n"), alternatives: [],
        evidence: { sourceIdentifiers: { incidentId, warehouseId: warehouseId || "" }, operationalFacts: { analyzedCount: rollup.analyzedCount, gapCount: rollup.gapCount, groups: rollup.groups } },
        confidence: rollup.gapCount ? 80 : 95, riskLevel: "HIGH", mode: "HUMAN_APPROVAL", actor: "current-session",
      }) });
      const payload = await response.json();
      if (!response.ok || payload.error) throw new Error(payload.message || payload.error || "Không thể tạo bản duyệt.");
      let currentDecision = payload.data;
      if (currentDecision?.decisionStatus === "DRAFT") {
        const ready = await fetch(`/api/decisions/${encodeURIComponent(currentDecision.decisionId)}/ready`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actor: "current-session", idempotencyKey: `ready:${currentDecision.decisionId}` }) });
        const readyPayload = await ready.json();
        if (!ready.ok || readyPayload.error) throw new Error(readyPayload.message || readyPayload.error || "Không thể chuyển bản tổng hợp sang chờ duyệt.");
        currentDecision = readyPayload.data;
      }
      setDecision(currentDecision);
    } catch (caught) { setReviewError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSubmitting(false); }
  };
  const review = async (action: "approve" | "reject") => {
    if (!decision) return;
    if (action === "reject" && !rejectReason.trim()) { setReviewError("Vui lòng nhập lý do từ chối."); return; }
    setSubmitting(true); setReviewError("");
    try {
      const response = await fetch(`/api/decisions/${encodeURIComponent(decision.decisionId)}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actor: "current-session", rejectReason: rejectReason.trim() || undefined, idempotencyKey: `${action}:${decision.decisionId}` }) });
      const payload = await response.json();
      if (!response.ok || payload.error) throw new Error(payload.message || payload.error || "Không thể cập nhật phê duyệt.");
      setDecision(payload.data);
    } catch (caught) { setReviewError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSubmitting(false); }
  };
  const pending = decision?.decisionStatus === "READY_FOR_REVIEW";
  return <div className="mt-4 border-t border-slate-800 pt-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold text-emerald-200">Phê duyệt ngay tại sự cố này</p>{decision && <span className="rounded-full border border-emerald-500/40 px-2.5 py-1 text-xs font-bold text-emerald-200">{decision.decisionStatus}</span>}</div>{!decision && <button type="button" onClick={() => void createReview()} disabled={submitting || rollup.groups.length === 0} className="mt-3 inline-flex min-h-11 items-center justify-center rounded-lg bg-emerald-600 px-4 font-semibold text-white hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:opacity-50">{submitting ? "Đang chuẩn bị…" : "Chuẩn bị bản duyệt cho sự cố này"}</button>}{pending && <div className="mt-3 space-y-3"><label htmlFor={`reject-reason-${incidentId}`} className="block text-sm font-semibold">Lý do từ chối <span className="font-normal text-slate-500">(chỉ bắt buộc khi từ chối)</span></label><textarea id={`reject-reason-${incidentId}`} rows={2} value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300"/><div className="flex flex-wrap gap-2"><button type="button" onClick={() => void review("reject")} disabled={submitting} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-rose-500/50 px-4 font-semibold text-rose-200 disabled:opacity-50">Từ chối</button><button type="button" onClick={() => void review("approve")} disabled={submitting} className="inline-flex min-h-11 items-center justify-center rounded-lg bg-emerald-600 px-4 font-semibold text-white disabled:opacity-50">{submitting ? "Đang xử lý…" : "Duyệt các hạng mục"}</button></div></div>}{decision?.decisionStatus === "APPROVED" && <p className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-100">Đã duyệt root cause và action của đúng sự cố này. Bước tiếp theo là người vận hành thực hiện action đã duyệt.</p>}{decision?.decisionStatus === "REJECTED" && <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-100">Đã từ chối bản tổng hợp này.</p>}{reviewError && <p role="alert" className="mt-3 text-sm text-rose-200">{reviewError}</p>}<p className="mt-3 text-xs leading-5 text-slate-400">Duyệt không tự liên hệ kho hoặc thực thi action.</p></div>;
}

function OperationalDecisionCards({ incidentId, warehouseId, rollup, followup }: { incidentId: string; warehouseId?: string; rollup: OperationalRollup; followup: Json | null }) {
  return <div className="grid gap-4 xl:grid-cols-2">
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5"><h2 className="flex items-center gap-2 text-lg font-bold"><BrainCircuit aria-hidden="true" size={20} className="text-blue-300"/>Nguyên nhân gốc & bằng chứng</h2><p className="mt-2 text-sm text-slate-400">Tổng hợp từ {rollup.analyzedCount} timeline trực tiếp; một đơn có thể thuộc nhiều nguyên nhân theo từng chặng.</p><div className="mt-4 space-y-2">{rollup.groups.map((group) => <article key={group.key} className="rounded-lg border border-slate-800 bg-slate-950/70 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold text-rose-100">{group.title}</p><span className="rounded-full bg-rose-500/10 px-2 py-1 text-xs font-bold text-rose-200">{group.orderCount} đơn</span></div><p className="mt-1 text-sm font-semibold text-cyan-200">Kho chịu trách nhiệm: {group.warehouseName}</p><p className="mt-1 text-sm leading-6 text-slate-400">Bằng chứng mẫu: {group.evidence}</p></article>)}</div>{rollup.gapCount > 0 && <p className="mt-3 text-sm text-amber-200">Còn {rollup.gapCount} đơn có timeline nhưng chưa khớp playbook.</p>}</section>
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5"><h2 className="flex items-center gap-2 text-lg font-bold"><Bot aria-hidden="true" size={20} className="text-indigo-300"/>Đề xuất xử lý</h2><p className="mt-2 text-sm leading-6 text-slate-400">Action dưới đây lấy trực tiếp từ Operations Playbook; AI không tự thực thi và chỉ bổ sung diễn giải khi thiếu rule.</p><ol className="mt-4 space-y-2">{rollup.groups.map((group, index) => <li key={group.key} className="rounded-lg border border-slate-800 bg-slate-950/70 p-3"><p className="font-semibold">Action {index + 1} · {group.warehouseName} · {group.orderCount} đơn</p><p className="mt-1 text-sm leading-6 text-emerald-200">{group.action}</p></li>)}</ol></section>
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-lg font-bold"><ClipboardCheck aria-hidden="true" size={20} className="text-emerald-300"/>Tổng hợp để duyệt</h2><span className="rounded-full border border-amber-500/40 px-2.5 py-1 text-xs font-bold text-amber-200">{rollup.groups.length} HẠNG MỤC</span></div><p className="mt-2 text-sm leading-6 text-slate-400">Người duyệt xác nhận từng root cause, kho chịu trách nhiệm, phạm vi đơn và action trước khi chuyển thành kế hoạch vận hành.</p><ol className="mt-4 space-y-2">{rollup.groups.map((group, index) => <li key={group.key} className="rounded-lg border border-slate-800 bg-slate-950/70 p-3"><p className="font-semibold">Duyệt {index + 1}: {group.title}</p><p className="mt-1 text-sm text-slate-300">{group.warehouseName} · {group.orderCount} đơn</p><p className="mt-1 text-sm text-slate-400">Cần duyệt action: {group.action}</p></li>)}</ol><OperationalReviewControl incidentId={incidentId} warehouseId={warehouseId} rollup={rollup}/></section>
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5"><h2 className="flex items-center gap-2 text-lg font-bold"><ShieldAlert aria-hidden="true" size={20} className="text-amber-300"/>Theo dõi kết quả</h2><p className="mt-2 text-sm leading-6 text-slate-400">Tạm giữ nguyên để hoàn thiện ở giai đoạn sau.</p>{followup ? <p className="mt-4 text-sm text-slate-300">Trạng thái hiện tại: {translateStatus(followup.currentState)} · Mức cải thiện: {followup.progressPercent ?? "—"}%</p> : <p className="mt-4 text-sm text-slate-500">Chưa có dữ liệu theo dõi kết quả.</p>}</section>
  </div>;
}

export default function IncidentDetailPage() {
  const params = useParams<{ incidentId: string }>();
  const incidentId = decodeURIComponent(params.incidentId);
  const [incident, setIncident] = useState<Json | null>(null);
  const [rootCause, setRootCause] = useState<Json | null>(null);
  const [planner, setPlanner] = useState<Json | null>(null);
  const [copilot, setCopilot] = useState<Json | null>(null);
  const [followup, setFollowup] = useState<Json | null>(null);
  const [history, setHistory] = useState<Json[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [operationalRollup, setOperationalRollup] = useState<OperationalRollup | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    const [dashboardResult, rootCauseResult, plannerResult, copilotResult, historyResult] = await Promise.allSettled([
      requestJson("/api/dashboard"),
      requestJson(`/api/debug/rootcause/${encodeURIComponent(incidentId)}`),
      requestJson(`/api/debug/planner/${encodeURIComponent(incidentId)}`),
      requestJson(`/api/copilot/incident/${encodeURIComponent(incidentId)}`),
      requestJson(`/api/debug/incidents/${encodeURIComponent(incidentId)}/history`),
    ]);
    const dashboard = dashboardResult.status === "fulfilled" ? dashboardResult.value : null;
    const historyPayload = historyResult.status === "fulfilled" ? historyResult.value : null;
    const dashboardIncident = (dashboard?.incidents?.items || []).find((item: Json) => item.incidentId === incidentId);
    const persistedIncident = historyPayload?.incident?.warehouseName ? historyPayload.incident : null;
    const selected = persistedIncident || dashboardIncident
      ? { ...(persistedIncident || {}), ...(dashboardIncident || {}) }
      : null;
    setIncident(selected ? { ...selected, sourceReasonName: selected.reasonName, reasonName: incidentSignalLabel(selected.reasonName) } : null);
    setFollowup((dashboard?.followups?.items || []).find((item: Json) => item.incidentKey === selected?.incidentKey) || null);
    if (!selected && dashboardResult.status === "rejected") {
      setError(dashboardResult.reason instanceof Error ? dashboardResult.reason.message : String(dashboardResult.reason));
    }
    setRootCause(rootCauseResult.status === "fulfilled" ? rootCauseResult.value : null);
    setPlanner(plannerResult.status === "fulfilled" ? plannerResult.value : null);
    setCopilot(copilotResult.status === "fulfilled" ? copilotResult.value : null);
    setHistory(historyPayload?.history || []);
    setLoading(false);
  }, [incidentId]);

  useEffect(() => { void load(); }, [load]);
  const analysis = rootCause?.analysis;
  const plannerRun = planner?.run || planner?.data || null;
  const plannerData = plannerRun?.result;
  const rawCopilotResult = copilot?.run?.copilotResult;
  const copilotResult = rawCopilotResult ? { ...rawCopilotResult, confidence: typeof rawCopilotResult.confidence === "object" ? rawCopilotResult.confidence?.score : rawCopilotResult.confidence } : null;
  const reviewStatus = copilot?.activeReview?.status || "PENDING";
  const latestHistory = history[0] || null;
  const sampleOrderCodes = latestHistory?.sampleOrderCodes || [];
  const latestAffectedCount = Number(latestHistory?.affectedOrderCount ?? incident?.affectedOrderCount ?? 0);
  const latestMaximumAgeHours = latestHistory?.maximumAgeHours ?? incident?.maximumAgeHours ?? null;
  const oldestOrderCode = latestHistory?.oldestOrderCode || null;
  const hasOrderMetrics = latestAffectedCount > 0;
  const analysisAffectedCount = Number(rootCause?.context?.currentAffectedCount ?? NaN);
  const analysisIsStale = Number.isFinite(analysisAffectedCount) && analysisAffectedCount !== latestAffectedCount;
  const pickupJourneyCoverage = Number(rootCause?.context?.pickupJourneyCoveragePercent ?? 0);
  const pickupDelayedOrderCount = Number(rootCause?.context?.pickupDelayedOrderCount ?? 0);
  const maximumPickupWaitHours = rootCause?.context?.maximumPickupWaitHours ?? null;
  const delayedCustomers = rootCause?.context?.pickupDelayedCustomerBreakdown || [];
  const delayedWarehouses = rootCause?.context?.pickupDelayedWarehouseBreakdown || [];
  const supplementalCauses = (analysis?.causes || []).filter((cause: Json) =>
    cause.code !== "PICKUP_DELAY_DIRECT" && repairOperationalText(cause.title) !== "Chậm xử lý tại đầu lấy"
  );
  const sourceReasonName = incident?.sourceReasonName || incident?.reasonName;
  const ruleExplanation = incidentRuleExplanation(sourceReasonName);

  return <main id="main-content" tabIndex={-1} className="min-h-dvh bg-slate-950 px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
    <div className="mx-auto max-w-7xl space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div><Link href="/incidents" className="inline-flex min-h-11 items-center gap-2 rounded-md text-sm font-semibold text-blue-300 hover:text-blue-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"><ArrowLeft aria-hidden="true" size={17}/>Danh sách sự cố</Link><h1 className="mt-2 break-words text-2xl font-bold sm:text-3xl">{incident?.reasonName || "Chi tiết sự cố"}</h1><p className="mt-1 break-all font-mono text-xs text-slate-400">{incidentId}</p></div>
        <div className="flex flex-col gap-2 sm:flex-row">{copilotResult && <Link href={`/copilot/${encodeURIComponent(incidentId)}`} className="inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300"><ClipboardCheck aria-hidden="true" size={17}/>Mở bản tổng hợp để duyệt</Link>}<button type="button" onClick={() => void load()} disabled={loading} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 text-sm font-semibold hover:bg-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:opacity-50"><RefreshCw aria-hidden="true" size={17} className={loading ? "animate-spin motion-reduce:animate-none" : ""}/>Làm mới</button></div>
      </header>
      {loading && <p className="rounded-xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-400">Đang tổng hợp Incident, Root Cause, Planner và Copilot…</p>}
      {error && <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-rose-200"><p className="font-semibold">Dữ liệu incident chưa sẵn sàng</p><p className="mt-1 text-sm">{error}</p></div>}
      {!loading && incident && <section aria-label="Tổng quan sự cố" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[['Kho vận hành', incident.warehouseName], ['Đơn ảnh hưởng', hasOrderMetrics ? latestAffectedCount : 'Chưa có dữ liệu'], ['Mức ưu tiên', incident.priorityScore], ['Tuổi lớn nhất', hasOrderMetrics && latestMaximumAgeHours !== null ? `${latestMaximumAgeHours} giờ` : 'Chưa có dữ liệu']].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-slate-800 bg-slate-900 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p><p className="mt-2 break-words text-lg font-bold">{value ?? "—"}</p></div>)}
      </section>}
      {!loading && incident && <section aria-label="Phạm vi kết luận của tín hiệu" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-5"><h2 className="text-lg font-bold text-amber-100">Hệ thống đang quan sát điều gì?</h2><div className="mt-4 grid gap-4 lg:grid-cols-2"><div><p className="text-sm font-semibold text-slate-100">Điều dữ liệu chứng minh</p><p className="mt-2 text-sm leading-6 text-slate-300"><strong>{latestAffectedCount} đơn khớp tín hiệu</strong> tại cùng kho. Điều kiện rule: {ruleExplanation}</p><p className="mt-2 text-sm leading-6 text-slate-400">Con số này không có nghĩa {latestAffectedCount} đơn đã được chứng minh trễ do “{sourceReasonName}”.</p></div><div><p className="text-sm font-semibold text-slate-100">Điều chưa thể kết luận</p><p className="mt-2 text-sm leading-6 text-slate-300">Nguồn hiện chưa có thời điểm chuyển trạng thái, số shipper/ca làm việc, công suất–diện tích kho, tình trạng xe hoặc lịch trung chuyển. Vì vậy các giả thuyết thiếu người, kho tắc, thiếu diện tích và xe trễ đều cần được kiểm tra thực tế.</p></div></div></section>}
      {!loading && incident && <section aria-label="Hướng dẫn đọc sự cố" className="rounded-xl border border-blue-500/25 bg-blue-500/5 p-5"><h2 className="text-lg font-bold">Bảng hướng dẫn đọc màn hình</h2><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead className="text-xs uppercase text-slate-400"><tr><th className="border-b border-slate-700 p-3">Chỉ số</th><th className="border-b border-slate-700 p-3">Đang thể hiện gì</th><th className="border-b border-slate-700 p-3">Cách kiểm tra</th></tr></thead><tbody className="divide-y divide-slate-800"><tr><td className="p-3 font-semibold">Đơn ảnh hưởng: {latestAffectedCount}</td><td className="p-3 text-slate-300">Tổng số đơn thuộc incident ở snapshot gần nhất.</td><td className="p-3 text-slate-400">Đối chiếu các mã mẫu bên dưới với hệ thống nguồn.</td></tr><tr><td className="p-3 font-semibold">Mức ưu tiên: {incident.priorityScore}</td><td className="p-3 text-slate-300">Điểm deterministic = (hệ số số đơn + hệ số tuổi đơn) × trọng số loại sự cố. Điểm cao hơn được xếp trước.</td><td className="p-3 text-slate-400">Đây là điểm sắp xếp, không phải xác suất hoặc độ tin cậy AI.</td></tr><tr><td className="p-3 font-semibold">Tuổi lớn nhất: {latestMaximumAgeHours ?? '—'} giờ</td><td className="p-3 text-slate-300">Tuổi của đơn lâu nhất trong nhóm tại thời điểm snapshot.</td><td className="p-3 text-slate-400">{oldestOrderCode ? `Đơn lâu nhất: ${oldestOrderCode}.` : 'Snapshot chưa lưu mã đơn lâu nhất; dùng các mã mẫu để kiểm tra.'}</td></tr><tr><td className="p-3 font-semibold">Nhãn: {incident.reasonName}</td><td className="p-3 text-slate-300">Phân loại do rule vận hành gắn theo trạng thái/tuổi đơn.</td><td className="p-3 text-slate-400">Không phải khẳng định nguyên nhân nhân sự; cần xác minh tại kho.</td></tr></tbody></table></div></section>}
      {!loading && incident && <section aria-label="Mã đơn kiểm tra" className="rounded-xl border border-slate-800 bg-slate-900 p-5"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h2 className="text-lg font-bold">Dữ liệu để kiểm tra</h2><p className="mt-1 text-sm text-slate-400">Đang hiển thị {sampleOrderCodes.length} mã mẫu trên tổng {latestAffectedCount} đơn ảnh hưởng. Hệ thống chỉ lưu tối đa 5 mã mẫu trong incident history, không phải chỉ có 5 đơn.</p></div><Link href={`/decisions?incidentId=${encodeURIComponent(incidentId)}`} className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-300">Đưa vào SHADOW Decision</Link></div>{sampleOrderCodes.length > 0 ? <div className="mt-4 flex flex-wrap gap-2">{sampleOrderCodes.map((code: string) => <code key={code} className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-blue-200">{code}</code>)}</div> : <p className="mt-4 rounded-lg border border-dashed border-slate-700 p-4 text-sm text-amber-200">Chưa có mã đơn mẫu trong snapshot; không thể kiểm chứng số đơn hoặc tuổi đơn từ màn hình này.</p>}</section>}
      {!loading && incident && <><IncidentOrders incidentId={incidentId} onAnalysisChange={setOperationalRollup}/><PilotFeedbackForms incidentId={incidentId}/></>}{!operationalRollup?.analyzedCount && <div className="grid gap-4 xl:grid-cols-2">
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5"><h2 className="flex items-center gap-2 text-lg font-bold"><BrainCircuit aria-hidden="true" size={20} className="text-blue-300"/>Nguyên nhân gốc & bằng chứng</h2>{analysis ? <div className="mt-4 space-y-4">{analysisIsStale && <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm leading-6 text-rose-100"><strong>Phân tích đã cũ:</strong> bản phân tích dùng {analysisAffectedCount} đơn, trong khi snapshot mới nhất có {latestAffectedCount} đơn. Không dùng nội dung bên dưới để ra quyết định trước khi chạy lại AI.</div>}<div className={`rounded-lg border p-4 ${pickupDelayedOrderCount > 0 ? "border-emerald-500/40 bg-emerald-500/10" : "border-amber-500/30 bg-amber-500/10"}`}><p className={`font-semibold ${pickupDelayedOrderCount > 0 ? "text-emerald-100" : "text-amber-100"}`}>Kết luận từ dữ liệu hành trình</p><p className="mt-2 text-sm leading-6 text-slate-200">{pickupDelayedOrderCount > 0 ? `Ghi nhận ${pickupDelayedOrderCount}/${latestAffectedCount} đơn có thời gian từ lúc tạo đơn đến khi hoàn tất lấy hàng vượt 24 giờ; trường hợp dài nhất là ${maximumPickupWaitHours} giờ. Dữ liệu hành trình bao phủ ${pickupJourneyCoverage}% số đơn trong sự cố.` : `Dữ liệu hành trình hiện bao phủ ${pickupJourneyCoverage}% số đơn và chưa đủ timestamp để xác nhận chậm tại khâu lấy hàng.`}</p>{pickupDelayedOrderCount > 0 && <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2"><div className="rounded-lg bg-slate-950/50 p-3"><dt className="font-semibold text-slate-300">Khách hàng có đơn chậm lấy</dt><dd className="mt-1 leading-6 text-slate-100">{delayedCustomers.length > 0 ? delayedCustomers.map((item: Json) => `${item.name} (${item.count} đơn)`).join(", ") : "Chưa có dữ liệu phân nhóm khách hàng."}</dd></div><div className="rounded-lg bg-slate-950/50 p-3"><dt className="font-semibold text-slate-300">Kho lấy phát sinh chậm</dt><dd className="mt-1 leading-6 text-slate-100">{delayedWarehouses.length > 0 ? delayedWarehouses.map((item: Json) => `${item.name} (${item.count} đơn)`).join(", ") : "Chưa có dữ liệu phân nhóm kho lấy."}</dd></div></dl>}</div><div className="flex flex-wrap gap-2 text-xs"><span className="rounded-full border border-slate-700 px-2.5 py-1">Độ tin cậy {analysis.confidence}%</span><span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-amber-200">Rủi ro {analysis.risk?.level || "chưa rõ"} · {analysis.risk?.score ?? "—"}</span></div>{supplementalCauses.length > 0 && <div><p className="mb-2 text-sm font-semibold text-slate-300">Nhận định bổ sung</p><ul className="space-y-2">{supplementalCauses.map((cause: Json, index: number) => <li key={`${cause.title}-${index}`} className="rounded-lg bg-slate-950/70 p-3"><p className="font-semibold">{repairOperationalText(cause.title)}</p><p className="mt-1 text-sm leading-6 text-slate-400">{repairOperationalText(cause.explanation)}</p></li>)}</ul></div>}</div> : <p className="mt-4 text-sm text-slate-400">Chưa có phân tích nguyên nhân gốc khả dụng cho sự cố này.</p>}</section>
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5"><h2 className="flex items-center gap-2 text-lg font-bold"><Bot aria-hidden="true" size={20} className="text-indigo-300"/>Đề xuất xử lý</h2><p className="mt-1 text-sm leading-6 text-slate-400">Những việc hệ thống đề nghị người vận hành kiểm tra hoặc thực hiện; hệ thống không tự hành động.</p>{plannerData ? <div className="mt-4 space-y-4"><p className="leading-7 text-slate-200">{repairOperationalText(plannerData.executiveSummary)}</p><ul className="space-y-2">{(plannerData.recommendations || []).map((item: Json, index: number) => <li key={item.id || index} className="rounded-lg border border-slate-800 bg-slate-950/70 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold">{repairOperationalText(item.title)}</p><span className="text-xs font-bold uppercase text-amber-300">{translateStatus(item.priority)}</span></div><p className="mt-1 text-sm leading-6 text-slate-400">{repairOperationalText(item.description)}</p></li>)}</ul></div> : <p className="mt-4 text-sm text-slate-400">Chưa có đề xuất xử lý.</p>}</section>
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-lg font-bold"><ClipboardCheck aria-hidden="true" size={20} className="text-emerald-300"/>Tổng hợp để duyệt</h2><span className="rounded-full border border-slate-700 px-2.5 py-1 text-xs font-bold">{translateStatus(reviewStatus)}</span></div><p className="mt-1 text-sm leading-6 text-slate-400">AI gom nguyên nhân, bằng chứng, rủi ro và đề xuất để người có trách nhiệm quyết định.</p>{copilotResult ? <div className="mt-4 space-y-3"><p className="text-lg font-semibold">{repairOperationalText(copilotResult.summary?.title)}</p><p className="leading-7 text-slate-300">{repairOperationalText(copilotResult.summary?.description)}</p><p className="text-sm text-slate-400"><strong className="text-slate-200">Nguyên nhân nhận định:</strong> {repairOperationalText(copilotResult.summary?.rootCause)}</p><div className="flex flex-wrap gap-2 text-xs"><span className="rounded-full border border-slate-700 px-2.5 py-1">Độ tin cậy {copilotResult.confidence}%</span><span className="rounded-full border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-rose-200">Rủi ro {translateStatus(copilotResult.risk?.overallRisk)}</span><span className="rounded-full border border-slate-700 px-2.5 py-1">Leo thang {translateStatus(copilotResult.escalation?.level)}</span></div><Link href={`/copilot/${encodeURIComponent(incidentId)}`} className="inline-flex min-h-11 items-center rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400">Mở bản tổng hợp để duyệt</Link></div> : <p className="mt-4 text-sm text-slate-400">Chưa có bản tổng hợp để duyệt.</p>}</section>
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5"><h2 className="flex items-center gap-2 text-lg font-bold"><ShieldAlert aria-hidden="true" size={20} className="text-amber-300"/>Theo dõi kết quả</h2><p className="mt-1 text-sm leading-6 text-slate-400">Diễn biến số đơn sau thời điểm đề xuất; không mặc định chứng minh hành động đã tạo ra kết quả.</p>{followup ? <dl className="mt-4 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-slate-500">Trạng thái</dt><dd className="mt-1 font-semibold">{translateStatus(followup.currentState)}</dd></div><div><dt className="text-slate-500">Mức cải thiện</dt><dd className="mt-1 font-mono font-semibold">{followup.progressPercent ?? "—"}%</dd></div><div><dt className="text-slate-500">Đánh giá diễn biến</dt><dd className="mt-1 font-semibold">{translateStatus(followup.progressAssessment || "—")}</dd></div><div><dt className="text-slate-500">Lần kiểm tra kế tiếp</dt><dd className="mt-1 font-mono text-xs">{followup.nextActionAt ? new Date(followup.nextActionAt).toLocaleString("vi-VN") : "—"}</dd></div></dl> : <p className="mt-4 text-sm text-slate-400">Chưa có dữ liệu theo dõi kết quả.</p>}{copilotResult?.impact && <div className="mt-4 border-t border-slate-800 pt-4"><p className="text-sm font-semibold">Ảnh hưởng được bản tổng hợp ghi nhận</p><p className="mt-2 text-sm text-slate-400">Mức độ: {translateStatus(copilotResult.impact.severity)} · Khách hàng ảnh hưởng: {copilotResult.impact.affectedCustomers ?? "—"}</p></div>}</section>
      </div>}
      {operationalRollup?.analyzedCount ? <OperationalDecisionCards incidentId={incidentId} warehouseId={incident?.warehouseId} rollup={operationalRollup} followup={followup}/> : null}
    </div>
  </main>;
}
