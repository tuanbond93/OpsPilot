"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, ClipboardCheck, LockKeyhole, RefreshCw, Scale, ShieldCheck } from "lucide-react";
import type { PilotQualitySnapshot } from "@/services/pilot-quality";
import type { QualitySummary } from "@/services/interfaces/ICopilotQualityService";

type Payload = {
  ok: true;
  snapshot: PilotQualitySnapshot;
  copilotQuality: QualitySummary | null;
  limitations: string[];
};

const causeLabels: Record<string, string> = {
  UNKNOWN: "Chưa xác định",
  STAFFING: "Nhân sự",
  CAPACITY: "Công suất / diện tích",
  LINEHAUL: "Xe trung chuyển",
  PROCESS: "Quy trình",
  DATA_ERROR: "Dữ liệu sai",
  OTHER: "Khác",
};

const categoryLabels: Record<string, string> = {
  DATA: "Dữ liệu",
  SIGNAL: "Nhãn tín hiệu",
  AI: "Phân tích AI",
  UI: "Giao diện",
  OTHER: "Khác",
};

function percent(value: number | null) {
  return value === null ? "Chưa đủ mẫu" : `${Math.round(value * 100)}%`;
}

function StatCard({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <article className="rounded-xl border border-slate-800 bg-slate-900 p-5"><p className="text-sm font-semibold text-slate-400">{label}</p><p className="mt-2 text-3xl font-bold text-white">{value}</p><p className="mt-2 text-sm leading-6 text-slate-400">{detail}</p></article>;
}

const readinessLabels = {
  HAS_EVIDENCE: "Có bằng chứng",
  NO_EVIDENCE: "Chưa có bằng chứng",
  LIMITATION: "Còn giới hạn",
  SAFETY_LOCKED: "Đã khóa an toàn",
} as const;

export default function PilotQualityPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/pilot-quality", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || body.error || "Không tải được dữ liệu");
      setData(body);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const snapshot = data?.snapshot;
  const reviewed = snapshot ? snapshot.review.approved + snapshot.review.edited + snapshot.review.rejected : 0;

  return <main className="mx-auto min-h-dvh max-w-7xl space-y-6 bg-slate-950 p-4 text-slate-100 sm:p-6 lg:p-8">
    <header className="flex flex-col justify-between gap-4 border-b border-slate-800 pb-6 sm:flex-row sm:items-end">
      <div><p className="text-sm font-semibold text-blue-300">Bằng chứng chất lượng từ dữ liệu thực</p><h1 className="mt-1 text-3xl font-bold">Chất lượng Pilot</h1><p className="mt-2 max-w-3xl leading-7 text-slate-400">Màn hình này cho biết OpsPilot đã được con người kiểm chứng đến đâu. Chỉ số chưa đủ mẫu sẽ được ghi rõ, không tự coi là đạt.</p></div>
      <button onClick={() => void load()} disabled={loading} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 font-semibold transition-colors hover:bg-slate-800 disabled:cursor-wait disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"><RefreshCw aria-hidden="true" size={18} className={loading ? "animate-spin" : ""}/>{loading ? "Đang cập nhật…" : "Làm mới"}</button>
    </header>

    {error && <section role="alert" className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-4 text-rose-200"><p className="font-semibold">Không tải được scorecard</p><p className="mt-1 text-sm">{error}</p></section>}
    {loading && !data && <section role="status" aria-live="polite" className="rounded-xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-300">Đang tổng hợp verification, review, feedback và outcome…</section>}

    {snapshot && <>
      <section aria-label="Phạm vi mẫu" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Sự cố đã xác minh" value={snapshot.sample.verifiedIncidents} detail="Sự cố có ít nhất một xác minh nguyên nhân thực tế." />
        <StatCard label="Kết quả AI đã review" value={reviewed} detail="Tổng APPROVED, EDITED và REJECTED; không tính bản chờ duyệt." />
        <StatCard label="Decision có outcome" value={snapshot.sample.decisionsObserved} detail={`Bao phủ ${percent(snapshot.decision.outcomeCoverage)} tổng số Decision.`} />
        <StatCard label="Phản hồi đã xử lý" value={`${snapshot.feedback.resolved}/${snapshot.feedback.total}`} detail={`Tỷ lệ đóng phản hồi: ${percent(snapshot.feedback.resolutionRate)}.`} />
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6" aria-labelledby="readiness-title">
        <div className="flex items-start gap-3"><LockKeyhole aria-hidden="true" className="mt-1 shrink-0 text-violet-300"/><div><h2 id="readiness-title" className="text-xl font-bold">Checklist bằng chứng Level C</h2><p className="mt-1 max-w-3xl text-sm leading-6 text-slate-400">Đây là bản kiểm kê bằng chứng kỹ thuật, không phải chứng nhận Level C. Trạng thái thay đổi theo dữ liệu thực và các giới hạn production đã biết.</p></div></div>
        <div className="mt-5 grid gap-3 lg:grid-cols-2">{snapshot.readiness.map((item) => <article key={item.key} className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950 p-4">{item.state === "HAS_EVIDENCE" || item.state === "SAFETY_LOCKED" ? <CheckCircle2 aria-hidden="true" className="mt-0.5 shrink-0 text-emerald-400" size={20}/> : item.state === "LIMITATION" ? <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0 text-amber-400" size={20}/> : <CircleDashed aria-hidden="true" className="mt-0.5 shrink-0 text-slate-500" size={20}/>}<div className="min-w-0"><p className="font-semibold text-slate-100">{item.label}</p><p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{readinessLabels[item.state]}</p><p className="mt-2 text-sm leading-6 text-slate-400">{item.evidence}</p></div></article>)}</div>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6">
          <div className="flex items-start gap-3"><ClipboardCheck aria-hidden="true" className="mt-1 text-blue-300"/><div><h2 className="text-xl font-bold">Con người đánh giá AI thế nào?</h2><p className="mt-1 text-sm leading-6 text-slate-400">Nguồn: review Copilot đang active. “Sửa” cho biết AI có ích nhưng chưa thể dùng nguyên trạng.</p></div></div>
          <dl className="mt-5 grid grid-cols-3 gap-3 text-center"><div className="rounded-lg bg-slate-950 p-3"><dt className="text-sm text-slate-400">Duyệt</dt><dd className="mt-1 text-2xl font-bold text-emerald-400">{snapshot.review.approved}</dd></div><div className="rounded-lg bg-slate-950 p-3"><dt className="text-sm text-slate-400">Sửa</dt><dd className="mt-1 text-2xl font-bold text-amber-400">{snapshot.review.edited}</dd></div><div className="rounded-lg bg-slate-950 p-3"><dt className="text-sm text-slate-400">Từ chối</dt><dd className="mt-1 text-2xl font-bold text-rose-400">{snapshot.review.rejected}</dd></div></dl>
          <p className="mt-4 text-sm text-slate-300">Điểm người dùng: <strong>{snapshot.review.averageRating === null ? "Chưa có rating" : `${snapshot.review.averageRating}/5`}</strong></p>
          {data?.copilotQuality && reviewed > 0 && <p className="mt-2 text-sm text-slate-300">Mức đồng thuận có trọng số: <strong>{data.copilotQuality.agreementMetrics.weightedAgreement}%</strong> trên dữ liệu đã review.</p>}
        </article>

        <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6">
          <div className="flex items-start gap-3"><ShieldCheck aria-hidden="true" className="mt-1 text-emerald-300"/><div><h2 className="text-xl font-bold">Nguyên nhân thực tế đã xác minh</h2><p className="mt-1 text-sm leading-6 text-slate-400">Nguồn: biểu mẫu “Xác minh nguyên nhân thực tế” tại hồ sơ sự cố. Đây là nhãn do người vận hành nhập, không phải suy đoán của AI.</p></div></div>
          <div className="mt-5 space-y-3">{snapshot.verificationCauses.length > 0 ? snapshot.verificationCauses.map((item) => <div key={item.label} className="flex min-h-11 items-center justify-between rounded-lg bg-slate-950 px-4"><span>{causeLabels[item.label] || item.label}</span><strong>{item.count}</strong></div>) : <p className="rounded-lg border border-dashed border-slate-700 p-5 text-center text-slate-400">Chưa có xác minh để phân tích.</p>}</div>
        </article>
      </section>

      <section className="grid gap-6 xl:grid-cols-2" aria-label="Độ phủ xác minh">
        <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6"><h2 className="text-xl font-bold">Độ phủ theo kho</h2><p className="mt-1 text-sm leading-6 text-slate-400">Số bản ghi xác minh tại từng kho; nhiều bản ghi có thể thuộc cùng một sự cố.</p><div className="mt-5 space-y-2">{snapshot.verificationCoverage.byWarehouse.length ? snapshot.verificationCoverage.byWarehouse.map((item) => <div key={item.label} className="flex min-h-11 items-center justify-between gap-4 rounded-lg bg-slate-950 px-4"><span className="min-w-0 break-words">{item.label}</span><strong className="shrink-0 tabular-nums">{item.count}</strong></div>) : <p className="rounded-lg border border-dashed border-slate-700 p-5 text-center text-slate-400">Chưa có kho nào được xác minh.</p>}</div></article>
        <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6"><h2 className="text-xl font-bold">Độ phủ theo loại sự cố</h2><p className="mt-1 text-sm leading-6 text-slate-400">Nhãn sự cố tại thời điểm con người ghi nhận verification.</p><div className="mt-5 space-y-2">{snapshot.verificationCoverage.byIncidentType.length ? snapshot.verificationCoverage.byIncidentType.map((item) => <div key={item.label} className="flex min-h-11 items-center justify-between gap-4 rounded-lg bg-slate-950 px-4"><span className="min-w-0 break-words">{item.label}</span><strong className="shrink-0 tabular-nums">{item.count}</strong></div>) : <p className="rounded-lg border border-dashed border-slate-700 p-5 text-center text-slate-400">Chưa có loại sự cố nào được xác minh.</p>}</div></article>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6" aria-labelledby="activity-title"><h2 id="activity-title" className="text-xl font-bold">Hoạt động thu thập bằng chứng</h2><p className="mt-1 text-sm leading-6 text-slate-400">Tối đa 14 ngày có phát sinh dữ liệu gần nhất. Bảng thể hiện số record được tạo trong từng ngày, không phải điểm chất lượng.</p>{snapshot.activityTrend.length ? <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><thead><tr className="border-b border-slate-700 text-slate-400"><th className="px-3 py-3">Ngày</th><th className="px-3 py-3">Xác minh</th><th className="px-3 py-3">Review AI</th><th className="px-3 py-3">Phản hồi</th><th className="px-3 py-3">Outcome</th></tr></thead><tbody>{snapshot.activityTrend.map((item) => <tr key={item.date} className="border-b border-slate-800 last:border-0"><th scope="row" className="px-3 py-3 font-semibold">{new Date(`${item.date}T00:00:00`).toLocaleDateString("vi-VN")}</th><td className="px-3 py-3 tabular-nums">{item.verifications}</td><td className="px-3 py-3 tabular-nums">{item.reviews}</td><td className="px-3 py-3 tabular-nums">{item.feedback}</td><td className="px-3 py-3 tabular-nums">{item.outcomes}</td></tr>)}</tbody></table></div> : <p className="mt-5 rounded-lg border border-dashed border-slate-700 p-5 text-center text-slate-400">Chưa có hoạt động Pilot để tạo timeline.</p>}</section>

      <section className="grid gap-6 xl:grid-cols-2">
        <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6"><div className="flex items-start gap-3"><AlertTriangle aria-hidden="true" className="mt-1 text-amber-300"/><div><h2 className="text-xl font-bold">Vấn đề người dùng báo</h2><p className="mt-1 text-sm leading-6 text-slate-400">Mới: {snapshot.feedback.open} · Đang xử lý: {snapshot.feedback.inProgress} · Đã xử lý: {snapshot.feedback.resolved}</p></div></div><div className="mt-5 space-y-3">{snapshot.feedback.byCategory.length > 0 ? snapshot.feedback.byCategory.map((item) => <div key={item.label} className="flex min-h-11 items-center justify-between rounded-lg bg-slate-950 px-4"><span>{categoryLabels[item.label] || item.label}</span><strong>{item.count}</strong></div>) : <p className="text-slate-400">Chưa có phản hồi.</p>}</div><Link href="/pilot-feedback" className="mt-5 inline-flex min-h-11 items-center rounded-lg bg-blue-600 px-4 font-semibold hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400">Mở hàng đợi phản hồi</Link></article>
        <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6"><div className="flex items-start gap-3"><Scale aria-hidden="true" className="mt-1 text-violet-300"/><div><h2 className="text-xl font-bold">Decision và outcome</h2><p className="mt-1 text-sm leading-6 text-slate-400">Nguồn: Decision Core. SHADOW chỉ quan sát; không tự thực thi hành động.</p></div></div><dl className="mt-5 grid grid-cols-2 gap-3"><div className="rounded-lg bg-slate-950 p-4"><dt className="text-sm text-slate-400">SHADOW</dt><dd className="mt-1 text-2xl font-bold">{snapshot.decision.shadow}</dd></div><div className="rounded-lg bg-slate-950 p-4"><dt className="text-sm text-slate-400">Cần người duyệt</dt><dd className="mt-1 text-2xl font-bold">{snapshot.decision.humanApproval}</dd></div></dl><div className="mt-4 space-y-2">{snapshot.decision.outcomes.length > 0 ? snapshot.decision.outcomes.map((item) => <p key={item.label} className="flex justify-between text-sm"><span>{item.label}</span><strong>{item.count}</strong></p>) : <p className="rounded-lg border border-dashed border-slate-700 p-5 text-center text-slate-400">Chưa có outcome; chưa thể kết luận hiệu quả Decision.</p>}</div></article>
      </section>

      <section className="rounded-2xl border border-blue-500/30 bg-blue-950/20 p-5 sm:p-6"><div className="flex items-start gap-3"><CheckCircle2 aria-hidden="true" className="mt-1 shrink-0 text-blue-300"/><div><h2 className="text-lg font-bold">Cách dùng scorecard này</h2><ol className="mt-3 list-decimal space-y-2 pl-5 leading-6 text-slate-300"><li>Tăng số sự cố được xác minh tại nhiều kho trước khi đánh giá độ chính xác.</li><li>Xem tỷ lệ Duyệt/Sửa/Từ chối để biết Copilot có dùng được nguyên trạng hay cần hiệu chỉnh.</li><li>Đóng vòng SHADOW bằng outcome thực tế; không suy ra hiệu quả khi chưa có outcome.</li><li>Xử lý phản hồi mở để các lỗi dữ liệu, nhãn và UI không làm sai kết luận Pilot.</li></ol><p className="mt-4 text-xs text-slate-500">Cập nhật lúc {new Date(snapshot.generatedAt).toLocaleString("vi-VN")}</p></div></div></section>
      <section className="rounded-2xl border border-violet-500/30 bg-violet-950/10 p-5 sm:p-6"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><h2 className="text-lg font-bold">Chuẩn bị dữ liệu để AI học tốt hơn</h2><p className="mt-1 max-w-3xl text-sm leading-6 text-slate-400">Ghép Copilot prediction với nguyên nhân thực tế và chỉ xuất những case đã có human review.</p></div><Link href="/ai-learning" className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg bg-violet-600 px-4 font-semibold hover:bg-violet-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400">Mở AI Learning Dataset</Link></div></section>
    </>}
  </main>;
}
