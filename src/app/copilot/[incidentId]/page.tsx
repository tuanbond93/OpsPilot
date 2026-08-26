"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Check, Pencil, RefreshCw, ShieldAlert, X } from "lucide-react";
import { incidentRuleExplanation, incidentSignalLabel, repairOperationalText, translateStatus } from "@/app/_components/operationalText";
import { handleApiAccess } from "@/app/_components/apiAccess";
import { useOpsSession } from "@/app/_components/useOpsSession";

type ReviewStatus = "APPROVED" | "EDITED" | "REJECTED";
type Json = Record<string, any>;

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return repairOperationalText(value);
  if (typeof value === "object" && value && "level" in value) return translateStatus((value as { level?: unknown }).level);
  return repairOperationalText(JSON.stringify(value));
}

async function optionalJson(url: string): Promise<Json | null> {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  handleApiAccess(response, payload, "Không thể tải dữ liệu Copilot.");
  if (!response.ok) return null;
  return payload.error ? null : payload;
}

export default function CopilotReviewPage() {
  const params = useParams<{ incidentId: string }>();
  const incidentId = decodeURIComponent(params.incidentId);
  const [payload, setPayload] = useState<Json | null>(null);
  const [rootCause, setRootCause] = useState<Json | null>(null);
  const [planner, setPlanner] = useState<Json | null>(null);
  const [history, setHistory] = useState<Json[]>([]);
  const [incident, setIncident] = useState<Json | null>(null);
  const session = useOpsSession();
  const reviewer = session.actor;
  const [rating, setRating] = useState("");
  const [comment, setComment] = useState("");
  const [editedJson, setEditedJson] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<ReviewStatus | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    const [copilotData, rootCauseData, plannerData, historyData] = await Promise.all([
      optionalJson(`/api/copilot/incident/${encodeURIComponent(incidentId)}`), optionalJson(`/api/debug/rootcause/${encodeURIComponent(incidentId)}`), optionalJson(`/api/debug/planner/${encodeURIComponent(incidentId)}`), optionalJson(`/api/debug/incidents/${encodeURIComponent(incidentId)}/history`),
    ]);
    if (!copilotData) setError("Không tìm thấy Copilot result cho incident này.");
    setPayload(copilotData); setRootCause(rootCauseData); setPlanner(plannerData);
    setHistory(historyData?.history || []);
    setIncident(historyData?.incident || null);
    if (copilotData?.run?.copilotResult) setEditedJson(JSON.stringify(copilotData.run.copilotResult, null, 2));
    setLoading(false);
  }, [incidentId]);
  useEffect(() => { void load(); }, [load]);

  async function submit(status: ReviewStatus) {
    if (!session.can("REVIEW_COPILOT")) { setError("Tài khoản hiện tại không có quyền duyệt Copilot."); return; }
    if (!reviewer.trim()) { setError("Danh tính reviewer là bắt buộc."); return; }
    let editedResult: Json | undefined;
    if (status === "EDITED") { try { editedResult = JSON.parse(editedJson); } catch { setError("Nội dung chỉnh sửa phải là JSON hợp lệ."); return; } }
    setSubmitting(status); setError(""); setSuccess("");
    try {
      const response = await fetch(`/api/copilot/incident/${encodeURIComponent(incidentId)}/review`, { method: "POST", headers: { "Content-Type": "application/json", "x-reviewer-identity": reviewer.trim() }, body: JSON.stringify({ status, rating: rating ? Number(rating) : null, comment: comment.trim() || null, editedResult }) });
      const result = await response.json();
      handleApiAccess(response, result, "Review thất bại.");
      if (!result.ok) throw new Error(result.message || result.error || "Review thất bại.");
      setSuccess(`Đã lưu ${status}. Workflow tiếp tục ở trạng thái ${result.resumedState || "đã xử lý"}.`);
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSubmitting(null); }
  }

  const rawResult = payload?.run?.copilotResult;
  const result = rawResult ? { ...rawResult, confidence: typeof rawResult.confidence === "object" ? rawResult.confidence?.score : rawResult.confidence } : null;
  const reviewStatus = payload?.activeReview?.status || "PENDING";
  const plannerResult = planner?.run?.result || planner?.data?.result;
  const latestAffectedCount = Number(history[0]?.affectedOrderCount ?? 0);
  const copilotAffectedCount = Number(result?.impact?.affectedCustomers ?? rootCause?.context?.currentAffectedCount ?? NaN);
  const resultIsStale = Number.isFinite(copilotAffectedCount) && copilotAffectedCount !== latestAffectedCount;
  const reasonName = repairOperationalText(incident?.reasonName || "Tín hiệu vận hành chưa xác định");
  const warehouseName = repairOperationalText(incident?.warehouseName || "Kho chưa xác định");
  const signalLabel = incidentSignalLabel(reasonName);
  const ruleExplanation = incidentRuleExplanation(reasonName);
  const latestSnapshot = history[0] || null;
  const maximumAgeHours = latestSnapshot?.maximumAgeHours;

  return <main id="main-content" tabIndex={-1} className="min-h-dvh bg-slate-950 px-4 py-6 text-slate-100 sm:px-6 lg:px-8"><div className="mx-auto max-w-7xl space-y-5">
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><Link href="/reviews" className="inline-flex min-h-11 items-center gap-2 rounded-md text-sm font-semibold text-blue-300 hover:text-blue-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"><ArrowLeft aria-hidden="true" size={17}/>Các bản cần phê duyệt</Link><div className="mt-2 flex flex-wrap items-center gap-3"><h1 className="text-2xl font-bold sm:text-3xl">Phê duyệt bản tổng hợp sự cố</h1><span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-bold text-amber-200">{translateStatus(reviewStatus)}</span></div><p className="mt-1 text-sm text-slate-400">Kiểm tra bằng chứng và đề xuất trước khi phê duyệt, chỉnh sửa hoặc từ chối.</p><p className="mt-1 break-all font-mono text-xs text-slate-500">{incidentId}</p></div><button type="button" onClick={() => void load()} disabled={loading} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 text-sm font-semibold hover:bg-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:opacity-50"><RefreshCw aria-hidden="true" size={17} className={loading ? "animate-spin motion-reduce:animate-none" : ""}/>Làm mới</button></header>
    <div aria-live="polite" aria-atomic="true">{loading && <p className="rounded-xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-400">Đang tải Copilot result…</p>}{error && <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-rose-200">{error}</div>}{success && <div role="status" className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-emerald-200">{success}</div>}</div>
    {result && <>{resultIsStale && <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm leading-6 text-rose-100"><strong>Kết quả Copilot đã cũ:</strong> kết quả này dùng {copilotAffectedCount} đơn, snapshot mới nhất có {latestAffectedCount} đơn. Không phê duyệt trước khi tạo lại phân tích từ dữ liệu mới.</div>}<section aria-labelledby="incident-definition-title" className="rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-5 sm:p-6"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">Sự cố đang được duyệt</p><h2 id="incident-definition-title" className="mt-2 text-2xl font-bold text-white">{signalLabel} tại {warehouseName}</h2><p className="mt-3 max-w-4xl text-base leading-7 text-slate-200"><strong>Hiểu ngắn gọn:</strong> snapshot mới nhất ghi nhận <strong className="text-white">{latestAffectedCount} đơn</strong> cùng khớp một tín hiệu bất thường tại kho này{maximumAgeHours !== null && maximumAgeHours !== undefined ? `; đơn lâu nhất đã tồn tại ${maximumAgeHours} giờ` : ""}.</p><dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><div className="rounded-lg border border-slate-800 bg-slate-950 p-3"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tín hiệu gì?</dt><dd className="mt-1 font-bold text-cyan-100">{reasonName}</dd></div><div className="rounded-lg border border-slate-800 bg-slate-950 p-3"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Xảy ra ở đâu?</dt><dd className="mt-1 font-bold">{warehouseName}</dd></div><div className="rounded-lg border border-slate-800 bg-slate-950 p-3"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Ảnh hưởng hiện tại?</dt><dd className="mt-1 font-bold">{latestAffectedCount} đơn</dd></div><div className="rounded-lg border border-slate-800 bg-slate-950 p-3"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Rule phát hiện</dt><dd className="mt-1 text-sm leading-5 text-slate-300">{ruleExplanation}</dd></div></dl><div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm leading-6 text-amber-100"><strong>Phạm vi kết luận:</strong> “{reasonName}” là nhãn tín hiệu do rule trạng thái/tuổi đơn phát hiện, chưa phải nguyên nhân gốc đã được xác minh. Nguyên nhân thực tế vẫn cần đối chiếu bằng chứng vận hành bên dưới.</div></section><section className="rounded-xl border border-slate-800 bg-slate-900 p-5"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-300">Nhận định của Copilot</p><h2 className="mt-2 text-xl font-bold">{displayValue(result.summary?.title).replace(/^Incident .* Overview$/, `Bản phân tích sự cố`)}</h2><p className={`mt-3 max-w-4xl leading-7 ${resultIsStale ? "text-slate-500" : "text-slate-300"}`}>{displayValue(result.summary?.description)}</p><dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><div className="rounded-lg bg-slate-950 p-3"><dt className="text-xs text-slate-500">Độ tin cậy</dt><dd className="mt-1 font-mono text-lg font-bold">{displayValue(result.confidence)}%</dd></div><div className="rounded-lg bg-slate-950 p-3"><dt className="text-xs text-slate-500">Rủi ro</dt><dd className="mt-1 text-lg font-bold">{translateStatus(displayValue(result.risk?.overallRisk))}</dd></div><div className="rounded-lg bg-slate-950 p-3"><dt className="text-xs text-slate-500">Mức độ ảnh hưởng</dt><dd className="mt-1 text-lg font-bold">{translateStatus(displayValue(result.impact?.severity))}</dd></div><div className="rounded-lg bg-slate-950 p-3"><dt className="text-xs text-slate-500">Leo thang</dt><dd className="mt-1 text-lg font-bold">{translateStatus(displayValue(result.escalation?.level))}</dd></div></dl></section>
    <div className="grid gap-4 xl:grid-cols-2"><section className="rounded-xl border border-slate-800 bg-slate-900 p-5"><h2 className="text-lg font-bold">Nguyên nhân & bằng chứng</h2><p className="mt-3 leading-7 text-slate-300">{repairOperationalText(result.summary?.rootCause)}</p><ul className="mt-4 space-y-2 text-sm text-slate-400">{Object.values(result.evidence || {}).flat().map((item: any, index) => <li key={index} className="rounded-lg bg-slate-950 p-3">{repairOperationalText(item)}</li>)}</ul>{rootCause?.analysis?.summary && <p className="mt-4 border-t border-slate-800 pt-4 text-sm text-slate-400"><strong className="text-slate-200">Root Cause Agent:</strong> {repairOperationalText(rootCause.analysis.summary)}</p>}</section><section className="rounded-xl border border-slate-800 bg-slate-900 p-5"><h2 className="text-lg font-bold">Khuyến nghị & tác động</h2><ul className="mt-4 space-y-2">{(result.summary?.recommendedActions || []).map((action: string, index: number) => <li key={index} className="rounded-lg bg-slate-950 p-3 text-sm text-slate-300">{repairOperationalText(action)}</li>)}</ul><p className="mt-4 text-sm leading-6 text-slate-400"><strong className="text-slate-200">Lý do leo thang:</strong> {repairOperationalText(result.escalation?.rationale)}</p>{plannerResult?.executiveSummary && <p className="mt-4 border-t border-slate-800 pt-4 text-sm text-slate-400"><strong className="text-slate-200">Planner:</strong> {repairOperationalText(plannerResult.executiveSummary)}</p>}</section></div>
    <section className="rounded-xl border border-blue-500/25 bg-blue-500/5 p-5"><h2 className="flex items-center gap-2 text-lg font-bold"><ShieldAlert aria-hidden="true" size={20} className="text-blue-300"/>Quyết định của operator</h2><p className="mt-1 text-sm text-slate-400">Mỗi quyết định được lưu audit và tiếp tục workflow deterministic hiện có.</p>{!session.loading && !session.can("REVIEW_COPILOT") && <p role="status" className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-100">Vai trò {session.role} chỉ được xem kết quả, không có quyền duyệt Copilot.</p>}<div className="mt-4 grid gap-4 lg:grid-cols-3"><div><label htmlFor="reviewer" className="mb-2 block text-sm font-semibold">Người duyệt</label><input id="reviewer" value={reviewer} readOnly aria-readonly="true" autoComplete="username" placeholder="Đang đọc phiên đăng nhập…" className="min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-base text-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400"/></div><div><label htmlFor="rating" className="mb-2 block text-sm font-semibold">Đánh giá</label><select id="rating" value={rating} onChange={(event) => setRating(event.target.value)} disabled={!session.can("REVIEW_COPILOT")} className="min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-50"><option value="">Không đánh giá</option>{[1,2,3,4,5].map((value) => <option key={value} value={value}>{value}/5</option>)}</select></div><div><label htmlFor="comment" className="mb-2 block text-sm font-semibold">Nhận xét</label><input id="comment" value={comment} onChange={(event) => setComment(event.target.value)} disabled={!session.can("REVIEW_COPILOT")} placeholder="Bối cảnh hoặc lý do quyết định" className="min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:opacity-50"/></div></div><details className="mt-4 rounded-lg border border-slate-800 bg-slate-950/70 p-3"><summary className="cursor-pointer font-semibold text-slate-200">Chỉnh sửa kết quả Copilot trước khi duyệt</summary><label htmlFor="edited-result" className="mt-3 block text-sm text-slate-400">JSON đã chỉnh sửa</label><textarea id="edited-result" value={editedJson} onChange={(event) => setEditedJson(event.target.value)} disabled={!session.can("REVIEW_COPILOT")} rows={14} spellCheck={false} className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-xs leading-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-50"/></details><div className="mt-4 flex flex-col gap-2 sm:flex-row"><button type="button" onClick={() => void submit("REJECTED")} disabled={Boolean(submitting)||!session.can("REVIEW_COPILOT")||resultIsStale} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-rose-500/50 px-4 font-semibold text-rose-200 hover:bg-rose-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose-400 disabled:opacity-50"><X aria-hidden="true" size={17}/>Từ chối</button><button type="button" onClick={() => void submit("EDITED")} disabled={Boolean(submitting)||!session.can("REVIEW_COPILOT")||resultIsStale} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-amber-500/50 px-4 font-semibold text-amber-200 hover:bg-amber-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 disabled:opacity-50"><Pencil aria-hidden="true" size={17}/>Phê duyệt bản đã chỉnh sửa</button><button type="button" onClick={() => void submit("APPROVED")} disabled={Boolean(submitting)||!session.can("REVIEW_COPILOT")||resultIsStale} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 font-semibold text-white hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400 disabled:opacity-50"><Check aria-hidden="true" size={17}/>{submitting ? "Đang lưu và tiếp tục…" : "Phê duyệt"}</button></div></section></>}
  </div></main>;
}
