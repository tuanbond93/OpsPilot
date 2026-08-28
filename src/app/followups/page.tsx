"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, CircleAlert, RefreshCw, Send } from "lucide-react";
import { repairOperationalText } from "@/app/_components/operationalText";
import { handleApiAccess } from "@/app/_components/apiAccess";
import { useOpsSession } from "@/app/_components/useOpsSession";

interface FollowupCaseItem {
  id: string; incident_id: string; incident_key: string; warehouse_name?: string; reason_name?: string;
  reason_code?: string | null; zone_name?: string | null;
  current_state: string; baseline_affected_order_count: number; latest_affected_order_count: number;
  current_progress_percent: number; current_assessment: string; last_action_confirmed_at?: string | null;
  payload?: { warehouse?: string; reason?: string; rootCauseSummary?: string };
  telegramResponses?: Array<{
    id: string; type: "FEEDBACK" | "SIGNAL"; text: string | null; signal: string | null;
    sender: string; receivedAt: string; coveredCaseCount: number;
  }>;
}

const stateLabel: Record<string, string> = {
  NEW: "MỚI", FIRST_PUSH_PENDING: "CHỜ XÁC NHẬN NHẮC LẦN 1", SECOND_PUSH_PENDING: "CHỜ XÁC NHẬN NHẮC LẦN 2",
  ESCALATION_PENDING: "CHỜ XÁC NHẬN LEO THANG", ESCALATED: "ĐÃ LEO THANG", WAITING_FOR_RESPONSE: "CHỜ PHẢN HỒI",
  NEXT_CHECK_PENDING: "CHỜ KIỂM TRA LẠI", RESOLVED: "ĐÃ GIẢI QUYẾT", CLOSED: "ĐÃ ĐÓNG",
};
const assessmentLabel: Record<string, string> = {
  strong_progress: "Cải thiện mạnh", limited_progress: "Có cải thiện", no_progress: "Chưa cải thiện",
  no_material_progress: "Chưa cải thiện đáng kể", worsening: "Xấu đi", insufficient_data: "Chưa đủ dữ liệu",
};
const telegramSignalLabel: Record<string, string> = {
  ACKNOWLEDGED: "Đã nhận việc",
  NEEDS_SUPPORT: "Cần hỗ trợ",
  PROGRESS_UPDATED: "Đã cập nhật tiến độ",
};
const reasonLabel: Record<string, string> = {
  KHO_TON: "Tồn kho", THIEU_SHIPPER: "Thiếu shipper", PICKUP_COMPLETION_DELAY: "Khâu lấy hàng hoàn tất chậm",
  COT_MISSED: "Chưa xuất giao sau COT", TRANSFER_DELAY: "Luân chuyển kéo dài",
};
function readableReason(item: FollowupCaseItem) {
  const raw = String(item.reason_name || item.reason_code || "Sự cố chưa phân loại");
  return repairOperationalText(reasonLabel[raw] || raw.replace(/_/g, " "));
}
function errorMessage(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  if (caught && typeof caught === "object" && "message" in caught && typeof (caught as { message?: unknown }).message === "string") return (caught as { message: string }).message;
  return "Không thể tải danh sách theo dõi. Vui lòng thử lại.";
}

export default function FollowupsDashboard() {
  const session = useOpsSession();
  const [cases, setCases] = useState<FollowupCaseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [sendingTelegramId, setSendingTelegramId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [zoneFilter, setZoneFilter] = useState("Miền Bắc 3");

  const zones = useMemo(() => [...new Set(cases.map((item) => item.zone_name).filter((zone): zone is string => Boolean(zone)))].sort((a, b) => a.localeCompare(b, "vi")), [cases]);
  const visibleCases = useMemo(() => zoneFilter === "ALL" ? cases : cases.filter((item) => item.zone_name === zoneFilter), [cases, zoneFilter]);

  async function loadCases() {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/debug/followups", { cache: "no-store" });
      const payload = await response.json();
      handleApiAccess(response, payload, "Không thể tải danh sách theo dõi.");
      setCases(payload.cases || []);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setLoading(false); }
  }

  useEffect(() => { void loadCases(); }, []);

  async function confirmAction(item: FollowupCaseItem) {
    const action = item.current_state === "SECOND_PUSH_PENDING" ? "second_push" : item.current_state === "ESCALATION_PENDING" ? "escalation" : "first_push";
    setConfirmingId(item.id); setError("");
    try {
      const response = await fetch(`/api/debug/followups/${encodeURIComponent(item.id || item.incident_key)}/confirm`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, confirmedBy: session.actor }),
      });
      const payload = await response.json();
      handleApiAccess(response, payload, "Không thể xác nhận hành động.");
      if (payload.error) throw new Error(payload.message || payload.error || "Không thể xác nhận hành động.");
      await loadCases();
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setConfirmingId(null); }
  }

  async function sendFirstPushToTelegram(item: FollowupCaseItem) {
    if (!window.confirm(`Gửi NHẮC LẦN 1 thật vào Telegram cho case ${item.incident_key}? Tin nhắn sẽ vào group đã map, lưu audit và chuyển case sang “đã gửi”.`)) return;
    setSendingTelegramId(item.id); setError("");
    try {
      const response = await fetch(`/api/followups/${encodeURIComponent(item.id)}/telegram-first-push`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actor: session.actor }),
      });
      const payload = await response.json();
      handleApiAccess(response, payload, "Không thể gửi nhắc Telegram.");
      if (!response.ok || payload.error) throw new Error(payload.message || payload.error || "Không thể gửi nhắc Telegram.");
      await loadCases();
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setSendingTelegramId(null); }
  }

  return <main id="main-content" tabIndex={-1} className="mx-auto min-h-dvh max-w-7xl space-y-6 bg-slate-950 p-4 text-slate-100 sm:p-6">
    <header className="flex flex-col gap-3 border-b border-slate-800 pb-5 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-300">Sau đề xuất và xử lý</p><h1 className="mt-1 text-2xl font-bold sm:text-3xl">Theo dõi kết quả</h1><p className="mt-1 text-sm text-slate-400">So sánh số đơn hiện tại với mốc ban đầu để biết tình hình đang cải thiện, đứng yên hay xấu đi; không mặc định đây là tác động do hành động tạo ra.</p></div><button type="button" onClick={() => void loadCases()} disabled={loading} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 text-sm font-semibold hover:bg-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:opacity-50"><RefreshCw aria-hidden="true" size={17} className={loading ? "animate-spin motion-reduce:animate-none" : ""}/>Làm mới</button></header>

    <section className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-4"><h2 className="font-bold text-blue-100">Cách đọc màn hình này</h2><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead className="text-xs uppercase text-slate-400"><tr><th className="border-b border-slate-700 p-3">Chỉ số</th><th className="border-b border-slate-700 p-3">Ý nghĩa</th><th className="border-b border-slate-700 p-3">Cách diễn giải</th></tr></thead><tbody className="divide-y divide-slate-800"><tr><td className="p-3 font-semibold">Số đơn hiện tại</td><td className="p-3 text-slate-300">Số đơn còn thuộc incident ở lần kiểm tra mới nhất.</td><td className="p-3 text-slate-400">Càng thấp so với mốc ban đầu càng tốt.</td></tr><tr><td className="p-3 font-semibold">Mốc ban đầu</td><td className="p-3 text-slate-300">Số đơn khi follow-up bắt đầu.</td><td className="p-3 text-slate-400">Dùng làm mẫu số để tính tỷ lệ cải thiện.</td></tr><tr><td className="p-3 font-semibold">Mức cải thiện</td><td className="p-3 text-slate-300">(Mốc ban đầu − hiện tại) / mốc ban đầu × 100%.</td><td className="p-3 text-slate-400">Số dương là cải thiện; số âm là xấu đi. +100% nghĩa là số đơn đã giảm về 0.</td></tr><tr><td className="p-3 font-semibold">Đã xác nhận</td><td className="p-3 text-slate-300">Thời điểm operator xác nhận action đã được gửi/thực hiện.</td><td className="p-3 text-slate-400">“Chưa xác nhận” nghĩa là hệ thống chưa có bằng chứng delivery.</td></tr></tbody></table></div><Link href="/guide#followup" className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-blue-300 hover:text-blue-200">Xem hướng dẫn follow-up đầy đủ →</Link></section>

    {!session.loading && !session.can("MANAGE_FOLLOWUP") && <p role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-100">Vai trò {session.role} được xem tiến độ nhưng không có quyền xác nhận action follow-up.</p>}

    <div aria-live="polite">{loading && <p className="rounded-xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-400">Đang tải các case theo dõi…</p>}{error && <div role="alert" className="flex gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-rose-200"><CircleAlert aria-hidden="true" size={18}/>{error}</div>}</div>

    {!loading && !error && <><section aria-label="Bộ lọc danh sách theo dõi" className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900 p-4 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="font-semibold text-slate-100">Phạm vi theo dõi</h2><p className="mt-1 text-sm text-slate-400">Chỉ hiển thị case trong vùng bạn đang quan tâm.</p></div><label className="grid gap-1 text-sm font-semibold text-slate-200">Vùng<select value={zoneFilter} onChange={(event) => setZoneFilter(event.target.value)} className="min-h-11 min-w-56 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"><option value="ALL">Tất cả vùng ({cases.length})</option>{zones.map((zone) => <option key={zone} value={zone}>{zone} ({cases.filter((item) => item.zone_name === zone).length})</option>)}</select></label></section><section aria-label="Danh sách case theo dõi" className="grid gap-4">{visibleCases.map((item) => {
      const state = item.current_state;
      const pending = state.includes("PENDING");
      const resolved = state === "RESOLVED" || state === "CLOSED";
      const progress = Number(item.current_progress_percent || 0);
      const improving = progress > 0;
      const warehouse = repairOperationalText(item.warehouse_name || "Kho chưa xác định");
      const reason = readableReason(item);
      return <article key={item.id} className={`rounded-xl border p-5 ${resolved ? "border-emerald-500/30 bg-emerald-500/5" : pending ? "border-amber-500/30 bg-amber-500/5" : "border-slate-800 bg-slate-900"}`}><div className="flex flex-col gap-3 border-b border-slate-800 pb-4 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-xs font-medium text-cyan-300">{item.zone_name || "Chưa gán vùng"}</p><h2 className="mt-1 text-lg font-bold">{warehouse}: {reason}</h2><p className="mt-1 font-mono text-xs text-slate-500">Mã theo dõi: {item.incident_key || item.incident_id}</p></div><div className="flex flex-wrap items-center gap-2"><span className="rounded-full border border-slate-700 px-3 py-1 text-xs font-bold">{stateLabel[state] || state}</span>{state === "FIRST_PUSH_PENDING" && session.can("MANAGE_FOLLOWUP") && <button type="button" onClick={() => void sendFirstPushToTelegram(item)} disabled={sendingTelegramId === item.id} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-cyan-600 px-3 text-xs font-bold text-white hover:bg-cyan-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 disabled:opacity-50"><Send aria-hidden="true" size={16}/>{sendingTelegramId === item.id ? "Đang gửi…" : "Gửi nhắc lần 1 Telegram"}</button>}{pending && session.can("MANAGE_FOLLOWUP") && <button type="button" onClick={() => void confirmAction(item)} disabled={confirmingId === item.id || sendingTelegramId === item.id} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-amber-500 px-3 text-xs font-bold text-slate-950 hover:bg-amber-400 disabled:opacity-50"><CheckCircle2 aria-hidden="true" size={16}/>{confirmingId === item.id ? "Đang xác nhận…" : "Xác nhận action"}</button>}</div></div><dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><div className="rounded-lg bg-slate-950 p-3"><dt className="text-xs text-slate-500">Số đơn hiện tại</dt><dd className="mt-1 text-lg font-bold text-blue-300">{item.latest_affected_order_count} đơn</dd></div><div className="rounded-lg bg-slate-950 p-3"><dt className="text-xs text-slate-500">Mốc ban đầu</dt><dd className="mt-1 text-lg font-bold">{item.baseline_affected_order_count} đơn</dd></div><div className="rounded-lg bg-slate-950 p-3"><dt className="text-xs text-slate-500">Mức cải thiện</dt><dd className={`mt-1 text-lg font-bold ${improving ? "text-emerald-300" : progress < 0 ? "text-rose-300" : "text-slate-300"}`}>{progress > 0 ? "+" : ""}{progress}%</dd><p className="mt-1 text-xs text-slate-400">{assessmentLabel[item.current_assessment] || item.current_assessment}</p></div><div className="rounded-lg bg-slate-950 p-3"><dt className="text-xs text-slate-500">Kết quả</dt><dd className={`mt-1 font-bold ${resolved ? "text-emerald-300" : "text-amber-300"}`}>{resolved ? "ĐÃ GIẢI QUYẾT" : "ĐANG THEO DÕI"}</dd></div><div className="rounded-lg bg-slate-950 p-3"><dt className="text-xs text-slate-500">Xác nhận action gần nhất</dt><dd className="mt-1 text-sm font-semibold">{item.last_action_confirmed_at ? new Date(item.last_action_confirmed_at).toLocaleString("vi-VN") : "Chưa xác nhận"}</dd></div></dl>{item.telegramResponses?.length ? <section className="mt-4 rounded-lg border border-cyan-500/25 bg-cyan-500/5 p-3" aria-label={`Phản hồi Telegram cho ${item.incident_key}`}><p className="text-xs font-semibold uppercase tracking-wide text-cyan-100">Phản hồi Telegram ({item.telegramResponses.length})</p><ul className="mt-2 space-y-2">{item.telegramResponses.map((response) => <li key={response.id} className="rounded-md border border-slate-700 bg-slate-950/70 p-3 text-sm"><p className="font-semibold text-slate-100">{response.sender} <span className="ml-1 text-xs font-normal text-slate-500">{new Date(response.receivedAt).toLocaleString("vi-VN")}</span></p>{response.type === "SIGNAL" ? <p className="mt-1 text-cyan-200">Tín hiệu: {telegramSignalLabel[response.signal || ""] || response.signal || "Đã cập nhật"}</p> : <p className="mt-1 whitespace-pre-wrap text-slate-300">{response.text}</p>}<p className="mt-2 text-xs text-slate-500">Phản hồi áp dụng cho {response.coveredCaseCount} case trong tin Telegram gộp.</p></li>)}</ul></section> : null}{item.payload?.rootCauseSummary && <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/70 p-3"><p className="text-xs font-semibold uppercase text-blue-300">Phân tích tham khảo</p><p className="mt-1 text-sm leading-6 text-slate-300">{repairOperationalText(item.payload.rootCauseSummary)}</p></div>}</article>;
    })}{visibleCases.length === 0 && <p className="rounded-xl border border-dashed border-slate-700 p-10 text-center text-slate-400">Không có case theo dõi trong vùng đã chọn.</p>}</section></>}
  </main>;
}
