"use client";

import { useState, useEffect } from "react";

interface FollowupCaseItem {
  id: string;
  incident_id: string;
  incident_key: string;
  warehouse_name?: string;
  reason_name?: string;
  current_state: string;
  baseline_affected_order_count: number;
  latest_affected_order_count: number;
  current_progress_percent: number;
  current_assessment: string;
  next_action_at?: string | null;
  last_action_requested_at?: string | null;
  last_action_confirmed_at?: string | null;
  resolved_at?: string | null;
  payload?: {
    warehouse: string;
    reason: string;
    currentCount: number;
    baselineCount: number;
    previousCount: number;
    progressPercent: number;
    progressAssessment: string;
    riskScore: number;
    riskLevel: string;
    rootCauseSummary: string;
    state: string;
    nextActionAt?: string | null;
    lastActionRequestedAt?: string | null;
    lastActionConfirmedAt?: string | null;
    escalationRequired: boolean;
  };
}

export default function FollowupsDashboard() {
  const [cases, setCases] = useState<FollowupCaseItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadCases() {
    try {
      setLoading(true);
      const res = await fetch("/api/debug/followups");
      const json = await res.json();
      setCases(json.cases || []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Failed to load follow-up cases: ${msg}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadCases();
  }, []);

  async function handleConfirm(caseId: string, state: string) {
    let action = "first_push";
    if (state === "SECOND_PUSH_PENDING") action = "second_push";
    if (state === "ESCALATION_PENDING") action = "escalation";

    try {
      setConfirmingId(caseId);
      const res = await fetch(`/api/debug/followups/${encodeURIComponent(caseId)}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, confirmedBy: "Dashboard Operator" }),
      });

      const json = await res.json();
      if (!res.ok || json.error) {
        throw new Error(json.message || json.error || "Confirmation failed");
      }

      await loadCases();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Confirmation Error: ${msg}`);
    } finally {
      setConfirmingId(null);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 max-w-6xl mx-auto space-y-8">
      <header className="border-b border-slate-800 pb-4 flex items-center justify-between">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-semibold uppercase tracking-wider mb-2">
            Operational State Machine & Action Governance
          </div>
          <h1 className="text-3xl font-extrabold text-slate-100">Follow-up & Escalation Dashboard</h1>
          <p className="text-sm text-slate-400">
            Deterministic state tracking separating requested actions from confirmed delivery
          </p>
        </div>
        <button
          onClick={loadCases}
          className="px-4 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-semibold rounded-xl text-slate-300 transition"
        >
          Refresh Cases
        </button>
      </header>

      {loading && (
        <div className="p-8 text-center text-slate-500 animate-pulse">Loading follow-up cases...</div>
      )}

      {error && (
        <div className="p-4 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs rounded-xl">
          {error}
        </div>
      )}

      {!loading && !error && (
        <div className="grid grid-cols-1 gap-4">
          {cases.map((c, idx) => {
            const p = c.payload;
            const state = c.current_state;
            const isPending = state.includes("PENDING");
            const isEscalated = state === "ESCALATED" || state === "ESCALATION_PENDING";
            const isResolved = state === "RESOLVED" || state === "CLOSED" || c.latest_affected_order_count === 0;

            return (
              <div
                key={c.id || idx}
                className={`p-6 bg-slate-900 border rounded-2xl space-y-4 shadow-xl transition ${
                  isEscalated
                    ? "border-rose-500/50 bg-rose-500/5"
                    : isPending
                    ? "border-amber-500/40 bg-amber-500/5"
                    : "border-slate-800 hover:border-slate-700"
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
                  <div>
                    <span className="text-xs font-mono text-slate-500 block">
                      Key: {c.incident_key || c.incident_id}
                    </span>
                    <h2 className="text-lg font-bold text-slate-100">
                      {p ? p.warehouse : c.warehouse_name || "Kho chưa xác định"} - {p ? p.reason : c.reason_name || "Sự cố"}
                    </h2>
                  </div>

                  <div className="flex items-center gap-3">
                    <span
                      className={`text-xs font-extrabold uppercase px-3 py-1 rounded-full border ${
                        isEscalated
                          ? "bg-rose-500/20 text-rose-400 border-rose-500/30 animate-pulse"
                          : isPending
                          ? "bg-amber-500/20 text-amber-300 border-amber-500/30"
                          : isResolved
                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                          : "bg-blue-500/10 text-blue-400 border-blue-500/20"
                      }`}
                    >
                      State: {state}
                    </span>

                    {isPending && (
                      <button
                        onClick={() => handleConfirm(c.id || c.incident_key, state)}
                        disabled={confirmingId === (c.id || c.incident_key)}
                        className="px-4 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs rounded-xl shadow-md transition disabled:opacity-50"
                      >
                        {confirmingId === (c.id || c.incident_key) ? "Confirming..." : "Confirm Action"}
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
                  <div className="p-3 bg-slate-950 rounded-xl border border-slate-800">
                    <span className="text-slate-400 block font-semibold">Incident Count</span>
                    <span className="text-base font-bold text-blue-400 mt-1 block">
                      {c.latest_affected_order_count !== undefined
                        ? c.latest_affected_order_count
                        : p?.currentCount || 0}{" "}
                      đơn
                    </span>
                  </div>

                  <div className="p-3 bg-slate-950 rounded-xl border border-slate-800">
                    <span className="text-slate-400 block font-semibold">Baseline Count</span>
                    <span className="text-base font-bold text-slate-300 mt-1 block">
                      {c.baseline_affected_order_count !== undefined
                        ? c.baseline_affected_order_count
                        : p?.baselineCount || 0}{" "}
                      đơn
                    </span>
                  </div>

                  <div className="p-3 bg-slate-950 rounded-xl border border-slate-800">
                    <span className="text-slate-400 block font-semibold">Progress Percent</span>
                    <span
                      className={`text-base font-bold mt-1 block ${
                        c.current_progress_percent < 0
                          ? "text-emerald-400"
                          : c.current_progress_percent > 0
                          ? "text-rose-400"
                          : "text-slate-300"
                      }`}
                    >
                      {c.current_progress_percent > 0 ? "+" : ""}
                      {c.current_progress_percent}% ({c.current_assessment})
                    </span>
                  </div>

                  <div className="p-3 bg-slate-950 rounded-xl border border-slate-800">
                    <span className="text-slate-400 block font-semibold">Resolution Status</span>
                    <span
                      className={`text-xs font-bold mt-1.5 block uppercase ${
                        isResolved ? "text-emerald-400" : "text-amber-400"
                      }`}
                    >
                      {isResolved ? "RESOLVED" : "ACTIVE"}
                    </span>
                  </div>

                  <div className="p-3 bg-slate-950 rounded-xl border border-slate-800">
                    <span className="text-slate-400 block font-semibold">Last Confirmed</span>
                    <span className="text-[11px] font-mono text-slate-300 mt-1 block truncate">
                      {c.last_action_confirmed_at
                        ? new Date(c.last_action_confirmed_at).toLocaleTimeString()
                        : "Unconfirmed"}
                    </span>
                  </div>
                </div>

                {p && p.rootCauseSummary && (
                  <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800 text-xs space-y-1">
                    <span className="font-semibold text-blue-400 uppercase tracking-wider block">
                      AI Root Cause Explanation:
                    </span>
                    <p className="text-slate-300">{p.rootCauseSummary}</p>
                  </div>
                )}
              </div>
            );
          })}

          {cases.length === 0 && (
            <div className="p-8 text-center text-slate-500 bg-slate-900 border border-slate-800 rounded-2xl">
              No active follow-up cases found in Event Store.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
