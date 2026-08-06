"use client";

import { useState, useEffect } from "react";

interface ActionItem {
  id: string;
  action_type: string;
  provider: string;
  target_type: string;
  target_id?: string | null;
  payload: Record<string, unknown>;
  status: string;
  priority: string;
  retry_count: number;
  max_retry: number;
  scheduled_at: string;
  started_at?: string | null;
  processed_at?: string | null;
  locked_at?: string | null;
  locked_by?: string | null;
  provider_message_id?: string | null;
  outcome?: string | null;
  last_error?: string | null;
  provider_response?: Record<string, unknown> | null;
}

interface ProviderHealthItem {
  name: string;
  status: "Healthy" | "Degraded" | "Offline";
  latencyMs?: number;
  details?: string;
}

export default function NotificationsDashboard() {
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [providers, setProviders] = useState<ProviderHealthItem[]>([]);
  const [metrics, setMetrics] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [operatingId, setOperatingId] = useState<string | null>(null);

  async function loadData() {
    try {
      setLoading(true);
      const [actionsRes, providersRes] = await Promise.all([
        fetch("/api/debug/actions"),
        fetch("/api/debug/providers"),
      ]);

      const actionsJson = await actionsRes.json();
      const providersJson = await providersRes.json();

      setActions(actionsJson.actions || []);
      setMetrics(actionsJson.metrics || {});
      setProviders(providersJson.providers || []);
    } catch (err: unknown) {
      console.error("Failed to load notifications data", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function handleRetry(actionId: string) {
    try {
      setOperatingId(actionId);
      const res = await fetch(`/api/debug/actions/${actionId}/retry`, { method: "POST" });
      if (!res.ok) throw new Error("Retry failed");
      await loadData();
    } catch (err: unknown) {
      alert(`Retry Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setOperatingId(null);
    }
  }

  async function handleCancel(actionId: string) {
    try {
      setOperatingId(actionId);
      const res = await fetch(`/api/debug/actions/${actionId}/cancel`, { method: "POST" });
      if (!res.ok) throw new Error("Cancel failed");
      await loadData();
    } catch (err: unknown) {
      alert(`Cancel Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setOperatingId(null);
    }
  }

  async function handleConfirmSimulated(actionId: string) {
    try {
      setOperatingId(actionId);
      const res = await fetch(`/api/debug/actions/${actionId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmedBy: "Dashboard Operator" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || "Manual confirmation failed");
      await loadData();
    } catch (err: unknown) {
      alert(`Confirmation Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setOperatingId(null);
    }
  }

  const filteredActions = actions.filter((a) => {
    const matchesStatus = statusFilter === "ALL" || a.status === statusFilter;
    const matchesSearch =
      searchQuery === "" ||
      a.action_type.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.provider.toLowerCase().includes(searchQuery.toLowerCase()) ||
      String(a.target_id || "").toLowerCase().includes(searchQuery.toLowerCase());
    return matchesStatus && matchesSearch;
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 max-w-6xl mx-auto space-y-8">
      <header className="border-b border-slate-800 pb-4 flex items-center justify-between">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs font-semibold uppercase tracking-wider mb-2">
            Notification Platform & Action Governance (Sprint 5 Hardened)
          </div>
          <h1 className="text-3xl font-extrabold text-slate-100">Notification Center</h1>
          <p className="text-sm text-slate-400">
            Decoupled asynchronous message queue with atomic claiming and audit events
          </p>
        </div>
        <button
          onClick={loadData}
          className="px-4 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-semibold rounded-xl text-slate-300 transition"
        >
          Refresh Queue
        </button>
      </header>

      {/* Provider Health Section */}
      <section className="space-y-3">
        <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider">Registered Notification Providers</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {providers.map((p) => (
            <div key={p.name} className="p-4 bg-slate-900 border border-slate-800 rounded-2xl flex items-center justify-between">
              <div>
                <span className="font-bold text-sm text-slate-100 capitalize block">{p.name} Provider</span>
                <span className="text-xs text-slate-400 block mt-0.5">{p.details || "Ready"}</span>
              </div>
              <span
                className={`text-xs font-extrabold uppercase px-2.5 py-1 rounded-full border ${
                  p.status === "Healthy"
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                    : p.status === "Degraded"
                    ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                    : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                }`}
              >
                {p.status}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 sm:grid-cols-7 gap-2 text-xs">
        <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
          <span className="text-slate-400 block font-semibold">Total Actions</span>
          <span className="text-lg font-bold text-slate-100 mt-1 block">{metrics.total || 0}</span>
        </div>
        <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
          <span className="text-amber-400 block font-semibold">Pending</span>
          <span className="text-lg font-bold text-amber-300 mt-1 block">{metrics.pending || 0}</span>
        </div>
        <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
          <span className="text-blue-400 block font-semibold">Processing</span>
          <span className="text-lg font-bold text-blue-300 mt-1 block">{metrics.processing || 0}</span>
        </div>
        <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
          <span className="text-emerald-400 block font-semibold">Sent (Delivered)</span>
          <span className="text-lg font-bold text-emerald-300 mt-1 block">{metrics.sent || 0}</span>
        </div>
        <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
          <span className="text-purple-400 block font-semibold">Simulated</span>
          <span className="text-lg font-bold text-purple-300 mt-1 block">{metrics.simulated || 0}</span>
        </div>
        <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
          <span className="text-rose-400 block font-semibold">Failed</span>
          <span className="text-lg font-bold text-rose-300 mt-1 block">{metrics.failed || 0}</span>
        </div>
        <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
          <span className="text-slate-500 block font-semibold">Cancelled</span>
          <span className="text-lg font-bold text-slate-400 mt-1 block">{metrics.cancelled || 0}</span>
        </div>
      </div>

      {/* Filter and Search Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between bg-slate-900/60 p-4 border border-slate-800 rounded-2xl">
        <div className="flex items-center gap-2 overflow-x-auto w-full sm:w-auto">
          {["ALL", "PENDING", "PROCESSING", "SENT", "SIMULATED", "FAILED", "CANCELLED"].map((st) => (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition ${
                statusFilter === st
                  ? "bg-indigo-600 text-slate-100"
                  : "bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800"
              }`}
            >
              {st}
            </button>
          ))}
        </div>

        <input
          type="text"
          placeholder="Search by action, provider, or target..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full sm:w-64 px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
        />
      </div>

      {/* Action Queue List */}
      {loading ? (
        <div className="p-8 text-center text-slate-500 animate-pulse">Loading action queue...</div>
      ) : (
        <div className="space-y-4">
          {filteredActions.map((a) => {
            const isPending = a.status === "PENDING";
            const isSimulated = a.status === "SIMULATED";
            const isFailed = a.status === "FAILED";

            return (
              <div
                key={a.id}
                className="p-5 bg-slate-900 border border-slate-800 rounded-2xl space-y-3 shadow-lg hover:border-slate-700 transition"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3">
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-mono text-slate-500">{a.id}</span>
                    <span className="text-sm font-bold text-slate-100 uppercase tracking-wider">{a.action_type}</span>
                    <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
                      Provider: {a.provider}
                    </span>
                  </div>

                  <div className="flex items-center gap-3">
                    <span
                      className={`text-xs font-extrabold uppercase px-2.5 py-1 rounded-full border ${
                        a.status === "SENT"
                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                          : a.status === "SIMULATED"
                          ? "bg-purple-500/10 text-purple-300 border-purple-500/20"
                          : a.status === "PENDING"
                          ? "bg-amber-500/10 text-amber-300 border-amber-500/20"
                          : a.status === "FAILED"
                          ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                          : "bg-slate-800 text-slate-400 border-slate-700"
                      }`}
                    >
                      {a.status}
                    </span>

                    {isSimulated && (
                      <button
                        onClick={() => handleConfirmSimulated(a.id)}
                        disabled={operatingId === a.id}
                        className="px-3 py-1 bg-indigo-500 hover:bg-indigo-400 text-slate-950 font-bold text-xs rounded-xl shadow transition"
                      >
                        {operatingId === a.id ? "Confirming..." : "Confirm Delivery (Dev)"}
                      </button>
                    )}

                    {isFailed && (
                      <button
                        onClick={() => handleRetry(a.id)}
                        disabled={operatingId === a.id}
                        className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs rounded-xl shadow transition"
                      >
                        {operatingId === a.id ? "Retrying..." : "Retry"}
                      </button>
                    )}

                    {isPending && (
                      <button
                        onClick={() => handleCancel(a.id)}
                        disabled={operatingId === a.id}
                        className="px-3 py-1 bg-rose-500/20 hover:bg-rose-500/30 text-rose-400 border border-rose-500/30 font-semibold text-xs rounded-xl transition"
                      >
                        {operatingId === a.id ? "Cancelling..." : "Cancel"}
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs text-slate-400">
                  <div>
                    <span className="block text-slate-500">Target</span>
                    <span className="text-slate-200 font-medium">{a.target_type}:{a.target_id || "global"}</span>
                  </div>
                  <div>
                    <span className="block text-slate-500">Outcome</span>
                    <span className="text-slate-200 font-medium uppercase">{a.outcome || a.status}</span>
                  </div>
                  <div>
                    <span className="block text-slate-500">Message ID</span>
                    <span className="text-slate-200 font-mono text-[11px] truncate block">
                      {a.provider_message_id || "N/A"}
                    </span>
                  </div>
                  <div>
                    <span className="block text-slate-500">Retries</span>
                    <span className="text-slate-200 font-medium">{a.retry_count} / {a.max_retry}</span>
                  </div>
                  <div>
                    <span className="block text-slate-500">Lock Info</span>
                    <span className="text-slate-300 font-mono text-[11px] truncate block">
                      {a.locked_by ? `${a.locked_by}` : "Unlocked"}
                    </span>
                  </div>
                </div>

                {a.last_error && (
                  <div className="p-2.5 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs rounded-xl font-mono">
                    Error: {a.last_error}
                  </div>
                )}

                {a.payload && (
                  <details className="text-xs text-slate-400 cursor-pointer">
                    <summary className="hover:text-slate-200 font-semibold select-none">
                      Inspect Payload & Provider Response
                    </summary>
                    <pre className="mt-2 p-3 bg-slate-950 rounded-xl border border-slate-800 font-mono text-[11px] overflow-x-auto text-slate-300">
                      {JSON.stringify({ payload: a.payload, provider_response: a.provider_response }, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            );
          })}

          {filteredActions.length === 0 && (
            <div className="p-8 text-center text-slate-500 bg-slate-900 border border-slate-800 rounded-2xl">
              No notification actions found matching your criteria.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
