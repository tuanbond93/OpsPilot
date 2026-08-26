"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, RefreshCw, Search } from "lucide-react";
import { incidentRuleExplanation, incidentSignalLabel, repairOperationalText, translateStatus } from "@/app/_components/operationalText";

interface Incident {
  incidentId: string; incidentKey: string; warehouseName: string; reasonName: string;
  priorityScore: number; affectedOrderCount: number; maximumAgeHours: number;
  risk?: { level?: string; score?: number }; trend?: string; followupState?: string;
  plannerStatus?: string; aiStatus?: string; lastDetectedAt?: string;
}

export default function IncidentListPage() {
  const [items, setItems] = useState<Incident[]>([]);
  const [source, setSource] = useState("");
  const [freshness, setFreshness] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.message || "Không thể tải danh sách sự cố.");
      setSource(payload.source || "unknown"); setFreshness(payload.dataFreshness || "unknown");
      if (payload.source === "degraded_fallback") {
        setItems([]);
        throw new Error("Nguồn vận hành đang unavailable; không hiển thị danh sách sự cố giả lập.");
      }
      setItems(payload.incidents?.items || []);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const filtered = useMemo(() => {
    const token = query.trim().toLocaleLowerCase("vi");
    return token ? items.filter((item) => [item.incidentKey, item.warehouseName, item.reasonName].some((value) => value?.toLocaleLowerCase("vi").includes(token))) : items;
  }, [items, query]);

  return <main id="main-content" tabIndex={-1} className="min-h-dvh bg-slate-950 px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
    <div className="mx-auto max-w-7xl space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-300">Operations queue</p><h1 className="mt-1 text-2xl font-bold sm:text-3xl">Sự cố cần xử lý</h1><p className="mt-1 text-sm text-slate-400">Ưu tiên theo dữ liệu vận hành hiện có; mở từng sự cố để xem bằng chứng và khuyến nghị AI.</p></div>
        <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 text-sm font-semibold hover:bg-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:opacity-50"><RefreshCw aria-hidden="true" size={17} className={loading ? "animate-spin motion-reduce:animate-none" : ""}/>Làm mới</button>
      </header>
      <div className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="w-full max-w-xl"><label htmlFor="incident-search" className="mb-2 block text-sm font-semibold">Tìm sự cố</label><div className="relative"><Search aria-hidden="true" size={17} className="absolute left-3 top-3.5 text-slate-500"/><input id="incident-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Mã sự cố, kho hoặc nguyên nhân" className="min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 pl-10 pr-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"/></div></div>
        <p className="text-xs text-slate-400">Nguồn: <span className="font-mono text-slate-200">{source || "—"}</span> · Freshness: <span className="font-mono text-slate-200">{freshness || "—"}</span></p>
      </div>
      <div aria-live="polite">{loading && <p className="rounded-xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-400">Đang tải sự cố…</p>}{error && <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-rose-200"><p className="font-semibold">Không tải được dữ liệu</p><p className="mt-1 text-sm">{error}</p></div>}{!loading && !error && filtered.length === 0 && <p className="rounded-xl border border-dashed border-slate-700 p-10 text-center text-slate-400">Không có sự cố phù hợp với bộ lọc hiện tại.</p>}</div>
      <section aria-label="Danh sách sự cố" className="grid gap-3">
        {filtered.map((incident) => <Link key={incident.incidentId} href={`/incidents/${encodeURIComponent(incident.incidentId)}`} className="group rounded-xl border border-slate-800 bg-slate-900 p-4 transition-colors hover:border-blue-500/50 hover:bg-slate-900/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div className="min-w-0"><div className="flex flex-wrap gap-2 text-xs font-semibold"><span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-amber-200"><AlertTriangle aria-hidden="true" className="mr-1 inline" size={13}/>Ưu tiên {incident.priorityScore}</span><span className="rounded-full border border-slate-700 px-2.5 py-1">Rủi ro: {translateStatus(incident.risk?.level || "unknown")}</span><span className="rounded-full border border-slate-700 px-2.5 py-1">Theo dõi: {translateStatus(incident.followupState || "NONE")}</span></div><h2 className="mt-3 break-words text-lg font-bold">{incidentSignalLabel(incident.reasonName)}</h2><p className="mt-1 break-words text-sm font-medium text-slate-300">{repairOperationalText(incident.warehouseName)}</p><p className="mt-1 max-w-3xl text-sm leading-6 text-slate-400">Ghi nhận {incident.affectedOrderCount ?? 0} đơn khớp tín hiệu. {incidentRuleExplanation(incident.reasonName)}</p><p className="mt-1 text-xs text-slate-500">Mã hồ sơ: {incident.incidentId.slice(0, 8)}</p></div><dl className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4"><div><dt className="text-xs text-slate-500">Đơn ảnh hưởng</dt><dd className="mt-1 font-mono font-bold">{incident.affectedOrderCount ?? "—"}</dd></div><div><dt className="text-xs text-slate-500">Tuổi lớn nhất</dt><dd className="mt-1 font-mono font-bold">{incident.maximumAgeHours ?? "—"} giờ</dd></div><div><dt className="text-xs text-slate-500">Phân tích AI</dt><dd className="mt-1 font-semibold">{translateStatus(incident.aiStatus || "NONE")}</dd></div><div className="flex items-end justify-end text-blue-300"><span className="sr-only">Mở chi tiết</span><ArrowRight aria-hidden="true" size={20}/></div></dl></div>
        </Link>)}
      </section>
    </div>
  </main>;
}
