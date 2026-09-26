"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, Check, Clipboard, Database, RefreshCw, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Diagnostic = Record<string, any>;
type ReadState = "IDLE" | "LOADING" | "PASS" | "PARTIAL" | "BLOCKED";

function readState(value: unknown): ReadState {
  return value === "PASS" || value === "PARTIAL" || value === "BLOCKED" ? value : "BLOCKED";
}

const DEFAULT_CHECKPOINT_LOCAL = "2026-09-26T08:00";

function checkpointUtc(localValue: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localValue)) return null;
  const parsed = Date.parse(`${localValue}:00+07:00`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "UNKNOWN";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "boolean") return value ? "YES" : "NO";
  return String(value);
}

function DataRow({ label, value }: { label: string; value: unknown }) {
  return <div className="flex min-w-0 items-start justify-between gap-4 border-b border-slate-800/80 py-2 last:border-0"><dt className="text-sm text-slate-400">{label}</dt><dd className="max-w-[65%] break-words text-right font-mono text-sm text-slate-100">{display(value)}</dd></div>;
}

function EvidenceCard({ title, icon: Icon, children }: { title: string; icon: typeof Activity; children: React.ReactNode }) {
  return <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg shadow-black/10 sm:p-5"><h2 className="flex items-center gap-2 font-bold text-white"><Icon aria-hidden="true" size={18} className="text-teal-300"/>{title}</h2><dl className="mt-3">{children}</dl></section>;
}

function statusTone(status: ReadState) {
  if (status === "PASS") return "border-teal-500/40 bg-teal-500/10 text-teal-100";
  if (status === "PARTIAL") return "border-amber-500/50 bg-amber-500/10 text-amber-100";
  if (status === "BLOCKED") return "border-rose-500/50 bg-rose-500/10 text-rose-100";
  return "border-slate-700 bg-slate-900 text-slate-200";
}

export default function CheckpointObservabilityClient() {
  const [checkpointLocal, setCheckpointLocal] = useState(DEFAULT_CHECKPOINT_LOCAL);
  const [state, setState] = useState<ReadState>("IDLE");
  const [evidence, setEvidence] = useState<Diagnostic | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const requestedAt = useMemo(() => checkpointUtc(checkpointLocal), [checkpointLocal]);

  const refresh = useCallback(async () => {
    if (!requestedAt) {
      setState("BLOCKED");
      setMessage("Checkpoint timestamp is invalid.");
      return;
    }
    setBusy(true);
    setState("LOADING");
    setMessage("");
    try {
      const supabase = createClient();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const response = await fetch(`/api/internal/observability/checkpoint?checkpointAt=${encodeURIComponent(requestedAt)}`, {
        method: "GET",
        cache: "no-store",
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const payload = await response.json();
      if (!response.ok || !payload?.evidence) {
        setEvidence(null);
        setState("BLOCKED");
        setMessage(response.status === 401 || response.status === 403
          ? "Access denied. Sign in with an ADMIN account that has MANAGE_SYSTEM."
          : "Evidence could not be read. Check access and try refreshing.");
        return;
      }
      setEvidence(payload.evidence);
      setState(readState(payload.evidence.metadata?.observability_status));
      setMessage("");
    } catch {
      setEvidence(null);
      setState("BLOCKED");
      setMessage("Evidence could not be read because the observability endpoint is unavailable.");
    } finally {
      setBusy(false);
    }
  }, [requestedAt]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function copyDiagnostic() {
    if (!evidence) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(evidence, null, 2));
      setMessage("Diagnostic JSON copied.");
    } catch {
      setMessage("Clipboard access failed. Select the JSON below and copy it manually.");
    }
  }

  const sync = evidence?.sync;
  const concurrency = evidence?.concurrency;
  const cron = evidence?.cron;
  const audit = evidence?.checkpoint_audit;
  const generation = evidence?.generation;
  const publication = evidence?.publication;
  const dispatch = evidence?.dispatch;
  const telegram = evidence?.telegram;

  return <main id="main-content" className="mx-auto w-full max-w-7xl px-4 py-7 sm:px-6 lg:py-10">
    <header className="flex flex-col gap-4 border-b border-teal-950 pb-6 sm:flex-row sm:items-start sm:justify-between">
      <div><p className="flex items-center gap-2 text-sm font-semibold text-teal-300"><Activity aria-hidden="true" size={17}/>PRODUCTION DIAGNOSTICS · READ ONLY</p><h1 className="mt-2 text-3xl font-bold tracking-tight text-white">Checkpoint observability</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">Inspect checkpoint, scheduler, generation and delivery evidence. This page has no retry, recovery, dispatch or cron controls.</p></div>
      <div className={`inline-flex min-h-11 items-center gap-2 self-start rounded-lg border px-3 text-sm font-bold ${statusTone(state)}`} aria-live="polite"><ShieldCheck aria-hidden="true" size={17}/>{state === "IDLE" ? "NOT READ" : state}</div>
    </header>

    <section aria-label="Checkpoint selector" className="mt-5 rounded-xl border border-slate-800 bg-slate-900/80 p-4 sm:p-5">
      <div className="grid gap-4 sm:grid-cols-[minmax(220px,1fr)_auto] sm:items-end">
        <label htmlFor="checkpoint-at" className="block text-sm font-semibold text-slate-200">Checkpoint timestamp <span className="font-normal text-slate-400">(Asia/Ho_Chi_Minh, UTC+07:00)</span><input id="checkpoint-at" type="datetime-local" step="60" value={checkpointLocal} onChange={(event) => setCheckpointLocal(event.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300"/></label>
        <button type="button" onClick={() => void refresh()} disabled={busy || !requestedAt} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#00a19a] px-4 font-bold text-slate-950 hover:bg-teal-300 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-200"><RefreshCw aria-hidden="true" size={17} className={busy ? "animate-spin" : ""}/>{busy ? "Reading…" : "Refresh evidence"}</button>
      </div>
      <p className="mt-2 font-mono text-xs text-slate-500">UTC request: {requestedAt ?? "Invalid timestamp"}</p>
      {message && <p role="status" className="mt-3 rounded-lg border border-slate-700 bg-slate-950/70 p-3 text-sm text-slate-200">{message}</p>}
      {evidence && <div className="mt-4 flex flex-wrap items-center gap-3"><button type="button" onClick={() => void copyDiagnostic()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-teal-700 px-4 font-semibold text-teal-100 hover:bg-teal-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300"><Clipboard aria-hidden="true" size={17}/>Copy diagnostic JSON</button><p className="text-xs text-slate-500">PASS means the evidence reads completed; it does not mean the checkpoint succeeded.</p></div>}
    </section>

    {evidence && <>
      <div className="mt-5 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-sm text-sky-100"><Database aria-hidden="true" className="mr-2 inline" size={16}/>Evidence package observed {display(evidence.metadata?.observed_at)}. Empty or unavailable evidence remains UNKNOWN/NOT_FOUND and is not treated as a checkpoint failure.</div>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <EvidenceCard title="Sync run" icon={Activity}><DataRow label="State" value={sync?.state}/><DataRow label="Run ID" value={sync?.sync_run_id}/><DataRow label="Status" value={sync?.sync_status}/><DataRow label="Current phase" value={sync?.current_phase}/><DataRow label="Completed phases" value={sync?.completed_phases}/><DataRow label="Last confirmed phase" value={sync?.last_confirmed_phase}/><DataRow label="Started / completed" value={`${display(sync?.started_at)} / ${display(sync?.completed_at)}`}/><DataRow label="Duration (ms)" value={sync?.duration_ms}/><DataRow label="Error code" value={sync?.sync_error_code}/><DataRow label="Safe error message" value={sync?.sync_error_message}/><DataRow label="Run count / duplicates" value={`${display(sync?.sync_run_count)} / ${display(sync?.duplicate_sync_run_count)}`}/></EvidenceCard>
        <EvidenceCard title="Concurrency lock" icon={ShieldCheck}><DataRow label="Running syncs" value={concurrency?.current_running_count}/><DataRow label="Active lock" value={concurrency?.active_sync_lock}/><DataRow label="Lock owner" value={concurrency?.lock_owner}/><DataRow label="Run link" value={concurrency?.lock_run_id_status}/><DataRow label="Acquired" value={concurrency?.lock_acquired_at}/><DataRow label="Expires" value={concurrency?.lock_expires_at}/><DataRow label="Heartbeat" value={concurrency?.lock_heartbeat_at}/></EvidenceCard>
        <EvidenceCard title="Cron execution" icon={RefreshCw}><DataRow label="Canonical job" value={cron?.cron_job_name}/><DataRow label="Job id / enabled" value={`${display(cron?.cron_job_id)} / ${display(cron?.cron_enabled)}`}/><DataRow label="Schedule" value={cron?.cron_schedule}/><DataRow label="Execution found" value={cron?.cron_execution_state}/><DataRow label="Start / end" value={`${display(cron?.cron_start)} / ${display(cron?.cron_end)}`}/><DataRow label="Status" value={cron?.cron_status}/><DataRow label="Return message" value={cron?.cron_return_message}/></EvidenceCard>
        <EvidenceCard title="Checkpoint audit" icon={AlertTriangle}><DataRow label="Audit state" value={audit?.checkpoint_audit_status}/><DataRow label="Audit found" value={audit?.checkpoint_audit_found}/><DataRow label="HTTP status" value={audit?.http_status}/><DataRow label="Error code" value={audit?.audit_error_code}/><DataRow label="Safe error" value={audit?.audit_error_message}/><DataRow label="Failure stage" value={audit?.failure_stage}/><DataRow label="Last confirmed phase" value={audit?.last_confirmed_phase}/><DataRow label="Eligible / first / second / escalation" value={`${display(dispatch?.eligible_count)} / ${display(dispatch?.first_push_count)} / ${display(dispatch?.second_push_count)} / ${display(dispatch?.escalation_count)}`}/><DataRow label="Resolved / skipped" value={`${display(dispatch?.resolved_count)} / ${display(dispatch?.skipped_count)}`}/></EvidenceCard>
        <EvidenceCard title="Generation and publication" icon={Database}><DataRow label="Generation" value={generation?.generation_status}/><DataRow label="Manifests" value={generation?.manifest_count}/><DataRow label="Expected / persisted / actual" value={`${display(generation?.expected_member_count)} / ${display(generation?.persisted_member_count)} / ${display(generation?.actual_member_count)}`}/><DataRow label="Duplicate sync runs" value={generation?.duplicate_sync_run_count}/><DataRow label="Duplicate generation" value={generation?.duplicate_generation_status}/><DataRow label="Completed at" value={generation?.generation_completed_at}/><DataRow label="Checkpoint pointer" value={publication?.checkpoint_pointer_status}/><DataRow label="Manifest pointer" value={publication?.manifest_pointer_status}/></EvidenceCard>
        <EvidenceCard title="Dispatch and Telegram" icon={Check}><DataRow label="Dispatcher audit" value={dispatch?.dispatcher_status}/><DataRow label="Dispatch error" value={dispatch?.dispatch_error}/><DataRow label="Telegram evidence" value={telegram?.status}/><DataRow label="Messages / success / failure" value={`${display(telegram?.telegram_message_count)} / ${display(telegram?.telegram_success_count)} / ${display(telegram?.telegram_failure_count)}`}/><DataRow label="Last sent" value={telegram?.telegram_last_sent_at}/><DataRow label="Audit attempts / success / failure" value={`${display(telegram?.audit_send_attempts)} / ${display(telegram?.audit_send_success)} / ${display(telegram?.audit_send_failed)}`}/></EvidenceCard>
      </div>
      <details className="mt-5 rounded-xl border border-slate-800 bg-slate-950/70 p-4"><summary className="min-h-11 cursor-pointer py-2 font-semibold text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300">View redacted diagnostic JSON</summary><pre className="mt-3 max-h-[34rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/60 p-3 text-xs leading-5 text-slate-300">{JSON.stringify(evidence, null, 2)}</pre></details>
    </>}
  </main>;
}
