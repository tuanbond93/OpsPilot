"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, BrainCircuit, CheckCircle2, Download, RefreshCw, ShieldCheck, XCircle } from "lucide-react";

type Candidate = { incidentId: string; warehouseName: string; incidentType: string; status: "ELIGIBLE" | "EXCLUDED"; reasons: string[] };
type Example = { exampleId: string; incidentId: string; warehouseName: string; incidentType: string; prompt: { version: string; provider: string; model: string }; prediction: { text: string; causeCode: string }; groundTruth: { causeCode: string; evidence: string }; review: { status: string; reviewedBy: string }; evaluation: { comparable: boolean; exactCauseMatch: boolean | null } };
type Dataset = {
  schemaVersion: string;
  datasetVersion: string;
  generatedAt: string;
  safeguards: { autoTraining: boolean; productionPromptMutation: boolean; autonomousExecution: boolean; eligibility: string };
  summary: { verificationCandidates: number; eligibleExamples: number; excludedCandidates: number; comparableExamples: number; exactCauseMatches: number; exactCauseAgreement: number | null };
  candidates: Candidate[];
  examples: Example[];
};

const reasonLabels: Record<string, string> = {
  EMPTY_VERIFICATION_EVIDENCE: "Verification chưa có bằng chứng",
  COPILOT_RUN_MISSING: "Chưa có kết quả Copilot",
  TERMINAL_HUMAN_REVIEW_MISSING: "Chưa được con người duyệt/sửa/từ chối",
};
const causeLabels: Record<string, string> = { STAFFING: "Nhân sự", CAPACITY: "Công suất / diện tích", LINEHAUL: "Xe trung chuyển", PROCESS: "Quy trình", DATA_ERROR: "Dữ liệu sai", OTHER: "Khác", UNKNOWN: "Chưa đủ dữ liệu" };

function Metric({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <article className="rounded-xl border border-slate-800 bg-slate-900 p-5"><p className="text-sm font-semibold text-slate-400">{label}</p><p className="mt-2 text-3xl font-bold tabular-nums">{value}</p><p className="mt-2 text-sm leading-6 text-slate-400">{detail}</p></article>;
}

export default function AiLearningPage() {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/ai-learning-dataset", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || body.error || "Không tải được dataset");
      setDataset(body.dataset);
    } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const agreement = dataset?.summary.exactCauseAgreement ?? null;
  return <main className="mx-auto min-h-dvh max-w-7xl space-y-6 bg-slate-950 p-4 text-slate-100 sm:p-6 lg:p-8">
    <Link href="/pilot-quality" className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-semibold text-blue-300 hover:bg-blue-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"><ArrowLeft aria-hidden="true" size={18}/>Chất lượng Pilot</Link>
    <header className="flex flex-col justify-between gap-4 border-b border-slate-800 pb-6 sm:flex-row sm:items-end"><div><p className="text-sm font-semibold text-violet-300">Dataset có giám sát từ người vận hành</p><h1 className="mt-1 text-3xl font-bold">AI Learning Dataset</h1><p className="mt-2 max-w-3xl leading-7 text-slate-400">Ghép nhận định Copilot với nguyên nhân thực tế đã xác minh. Pipeline chỉ chuẩn bị dữ liệu đánh giá; không tự huấn luyện hoặc thay đổi AI production.</p></div><button onClick={() => void load()} disabled={loading} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 font-semibold hover:bg-slate-800 disabled:cursor-wait disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400"><RefreshCw aria-hidden="true" size={18} className={loading ? "animate-spin" : ""}/>{loading ? "Đang tổng hợp…" : "Làm mới"}</button></header>

    {error && <section role="alert" className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-4 text-rose-200"><p className="font-semibold">Không tạo được dataset</p><p className="mt-1 text-sm">{error}</p></section>}
    {loading && !dataset && <section role="status" aria-live="polite" className="rounded-xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-300">Đang ghép verification, Copilot run và human review…</section>}

    {dataset && <>
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Tóm tắt dataset"><Metric label="Verification ứng viên" value={dataset.summary.verificationCandidates} detail="Mỗi incident chỉ lấy verification mới nhất."/><Metric label="Đủ điều kiện học" value={dataset.summary.eligibleExamples} detail="Có evidence, Copilot run và terminal human review."/><Metric label="Bị loại an toàn" value={dataset.summary.excludedCandidates} detail="Thiếu một trong các điều kiện bắt buộc."/><Metric label="AI khớp nguyên nhân" value={agreement === null ? "Chưa đủ mẫu" : `${Math.round(agreement * 100)}%`} detail={`${dataset.summary.exactCauseMatches}/${dataset.summary.comparableExamples} mẫu có thể so sánh.`}/></section>

      <section className="rounded-2xl border border-emerald-500/30 bg-emerald-950/10 p-5 sm:p-6"><div className="flex items-start gap-3"><ShieldCheck aria-hidden="true" className="mt-1 shrink-0 text-emerald-300"/><div><h2 className="text-xl font-bold">Hàng rào an toàn</h2><ul className="mt-3 space-y-2 text-sm leading-6 text-slate-300"><li>Không tự fine-tune model.</li><li>Không tự đổi prompt production.</li><li>Không kích hoạt AUTONOMOUS hoặc thực thi operation.</li><li>Eligibility: {dataset.safeguards.eligibility}.</li></ul><p className="mt-3 font-mono text-xs text-slate-500">{dataset.schemaVersion} · {dataset.datasetVersion}</p></div></div></section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start"><div><h2 className="text-xl font-bold">Ứng viên và lý do eligibility</h2><p className="mt-1 text-sm leading-6 text-slate-400">Danh sách này giải thích vì sao một verification được hoặc chưa được đưa vào dataset.</p></div>{dataset.summary.eligibleExamples > 0 ? <a href="/api/ai-learning-dataset?format=jsonl" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 font-semibold hover:bg-violet-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400"><Download aria-hidden="true" size={18}/>Tải JSONL</a> : <button disabled className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-slate-800 px-4 font-semibold text-slate-500 disabled:cursor-not-allowed"><Download aria-hidden="true" size={18}/>Chưa có mẫu để tải</button>}</div><div className="mt-5 space-y-3">{dataset.candidates.length ? dataset.candidates.map((item) => <article key={item.incidentId} className="flex flex-col justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950 p-4 sm:flex-row sm:items-start"><div className="min-w-0"><p className="font-semibold break-words">{item.warehouseName} · {item.incidentType}</p><p className="mt-1 font-mono text-xs text-slate-500 break-all">{item.incidentId}</p><p className="mt-2 text-sm text-slate-400">{item.reasons.length ? item.reasons.map((reason) => reasonLabels[reason] || reason).join(" · ") : "Đủ evidence và human review."}</p></div><span className={`inline-flex shrink-0 items-center gap-2 self-start rounded-full border px-3 py-1 text-xs font-bold ${item.status === "ELIGIBLE" ? "border-emerald-500/40 text-emerald-300" : "border-slate-700 text-slate-400"}`}>{item.status === "ELIGIBLE" ? <CheckCircle2 aria-hidden="true" size={15}/> : <XCircle aria-hidden="true" size={15}/>} {item.status === "ELIGIBLE" ? "ĐỦ ĐIỀU KIỆN" : "CHƯA ĐỦ"}</span></article>) : <p className="rounded-lg border border-dashed border-slate-700 p-6 text-center text-slate-400">Chưa có verification để tạo ứng viên.</p>}</div></section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6"><div className="flex items-start gap-3"><BrainCircuit aria-hidden="true" className="mt-1 shrink-0 text-violet-300"/><div><h2 className="text-xl font-bold">Mẫu đủ điều kiện</h2><p className="mt-1 text-sm leading-6 text-slate-400">So sánh deterministic giữa nhóm nguyên nhân AI và ground truth do người vận hành xác minh.</p></div></div><div className="mt-5 space-y-4">{dataset.examples.length ? dataset.examples.map((item) => <article key={item.exampleId} className="rounded-xl border border-slate-800 bg-slate-950 p-4"><div className="flex flex-col justify-between gap-2 sm:flex-row"><div><p className="font-semibold">{item.warehouseName} · {item.incidentType}</p><p className="mt-1 text-xs text-slate-500">Prompt {item.prompt.version} · {item.prompt.provider}/{item.prompt.model}</p></div><span className="text-sm font-semibold">{item.evaluation.exactCauseMatch === null ? "Chưa thể so sánh" : item.evaluation.exactCauseMatch ? "Khớp nguyên nhân" : "Không khớp nguyên nhân"}</span></div><div className="mt-4 grid gap-3 lg:grid-cols-2"><div className="rounded-lg bg-slate-900 p-4"><p className="text-xs font-semibold uppercase text-violet-300">AI dự đoán: {causeLabels[item.prediction.causeCode] || item.prediction.causeCode}</p><p className="mt-2 text-sm leading-6 text-slate-300">{item.prediction.text || "Copilot không trả về nguyên nhân rõ ràng."}</p></div><div className="rounded-lg bg-slate-900 p-4"><p className="text-xs font-semibold uppercase text-emerald-300">Con người xác minh: {causeLabels[item.groundTruth.causeCode] || item.groundTruth.causeCode}</p><p className="mt-2 text-sm leading-6 text-slate-300">{item.groundTruth.evidence}</p></div></div><p className="mt-3 text-xs text-slate-500">Review: {item.review.status} bởi {item.review.reviewedBy}</p></article>) : <p className="rounded-lg border border-dashed border-slate-700 p-6 text-center text-slate-400">Chưa có mẫu đủ điều kiện. Hãy review Copilot cho các incident đã có verification.</p>}</div></section>
      <p className="text-xs text-slate-500">Dataset tạo lúc {new Date(dataset.generatedAt).toLocaleString("vi-VN")}. Export là snapshot tại thời điểm tải.</p>
    </>}
  </main>;
}
