"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { handleApiAccess } from "@/app/_components/apiAccess";
import { useOpsSession } from "@/app/_components/useOpsSession";

type ShadowRun = {
  eventId: string;
  decisionId: string;
  occurredAt: string;
  observationState: string;
  observedAffectedOrders?: number | null;
};

export function ShadowEvidenceControl() {
  const session = useOpsSession();
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<ShadowRun[]>([]);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/decision-followups/shadow-runs", { cache: "no-store" });
      const result = await response.json();
      handleApiAccess(response, result, "Không thể tải lịch sử LC-10.");
      setRuns(result.data || []);
    } catch {
      setRuns([]);
    }
  }, []);

  useEffect(() => { if (open) void load(); }, [load, open]);

  async function run() {
    if (!session.can("MANAGE_SYSTEM")) { setMessage("Chỉ ADMIN được chạy LC-10 SHADOW thủ công."); return; }
    setRunning(true); setMessage("");
    try {
      const response = await fetch("/api/decision-followups/shadow-runs", { method: "POST" });
      const result = await response.json();
      handleApiAccess(response, result, "Không thể chạy LC-10 SHADOW.");
      const summary = result.data;
      setMessage(`Hoàn tất: quét ${summary.scannedCount}, ghi evidence ${summary.capturedCount}, chờ evidence ${summary.awaitingEvidenceCount}, lỗi ${summary.failedCount}.`);
      await load();
    } catch (error: unknown) {
      setMessage(`Không thể chạy: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setRunning(false); }
  }

  return <details className="rounded-2xl border border-slate-800 bg-slate-900" open={open} onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
    <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 sm:px-6">
      <span><span className="block font-semibold text-slate-200">Công cụ kỹ thuật: LC-10 SHADOW evidence</span><span className="mt-1 block text-sm text-slate-400">Chỉ thu evidence follow-up; không tạo verdict outcome hay tác động vận hành.</span></span>
      <ChevronDown aria-hidden="true" className={`shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
    </summary>
    <div className="border-t border-slate-800 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="max-w-2xl text-sm leading-6 text-slate-400">Khu vực này dành cho kiểm tra kỹ thuật của pilot, tách khỏi luồng điều hành hằng ngày.</p><button type="button" onClick={() => void run()} disabled={running || !session.can("MANAGE_SYSTEM")} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-cyan-400/50 bg-cyan-500/10 px-4 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300">{running ? <LoaderCircle aria-hidden="true" className="animate-spin" size={17}/> : <ShieldCheck aria-hidden="true" size={17}/>} {running ? "Đang chạy LC-10…" : "Chạy LC-10 SHADOW"}</button></div>
      {message && <p role={message.startsWith("Không thể") || message.startsWith("Chỉ ADMIN") ? "alert" : "status"} className={`mt-4 rounded-lg border p-3 text-sm ${message.startsWith("Không thể") || message.startsWith("Chỉ ADMIN") ? "border-rose-500/30 bg-rose-500/10 text-rose-200" : "border-cyan-500/30 bg-cyan-500/10 text-cyan-100"}`}>{message}</p>}
      <div className="mt-4 flex items-center justify-between gap-3"><h2 className="text-sm font-bold text-slate-200">Lịch sử evidence gần nhất</h2><button type="button" onClick={() => void load()} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-slate-300 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"><RefreshCw aria-hidden="true" size={16}/>Làm mới</button></div>
      <ul className="mt-3 space-y-2">{runs.length ? runs.slice(0, 5).map((run) => <li key={run.eventId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs"><span className={run.observationState === "READY_TO_VERIFY" ? "font-semibold text-emerald-200" : "font-semibold text-amber-200"}>{run.observationState === "READY_TO_VERIFY" ? `Evidence ${run.observedAffectedOrders ?? "—"} đơn` : "Chờ evidence"}</span><span className="font-mono text-slate-400">{run.decisionId.slice(0, 8)}</span><span className="text-slate-400">{new Date(run.occurredAt).toLocaleString("vi-VN")}</span></li>) : <li className="rounded-lg border border-dashed border-slate-700 p-4 text-sm text-slate-400">Chưa có lượt thu evidence.</li>}</ul>
    </div>
  </details>;
}
