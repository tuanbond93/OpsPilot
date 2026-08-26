"use client";

import { useState, useEffect } from "react";
import { handleApiAccess } from "@/app/_components/apiAccess";
import { useOpsSession } from "@/app/_components/useOpsSession";

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

const actionStatusLabel: Record<string,string>={PENDING:"Đang chờ",PROCESSING:"Đang xử lý",SENT:"Đã gửi",SIMULATED:"Mô phỏng",FAILED:"Thất bại",CANCELLED:"Đã hủy"};
const providerStatusLabel: Record<string,string>={Healthy:"Ổn định",Degraded:"Suy giảm",Offline:"Ngoại tuyến"};

export default function NotificationsDashboard() {
  const session = useOpsSession();
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [providers, setProviders] = useState<ProviderHealthItem[]>([]);
  const [metrics, setMetrics] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [operatingId, setOperatingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function loadData() {
    try {
      setLoading(true);
      setError("");
      const [actionsRes, providersRes] = await Promise.all([
        fetch("/api/debug/actions"),
        fetch("/api/debug/providers"),
      ]);

      const actionsJson = await actionsRes.json();
      const providersJson = await providersRes.json();

      handleApiAccess(actionsRes, actionsJson, "Không thể tải hàng đợi thông báo.");
      handleApiAccess(providersRes, providersJson, "Không thể tải trạng thái nhà cung cấp.");

      setActions(actionsJson.actions || []);
      setMetrics(actionsJson.metrics || {});
      setProviders(providersJson.providers || []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
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
      const payload = await res.json();
      handleApiAccess(res, payload, "Không thể thử gửi lại.");
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOperatingId(null);
    }
  }

  async function handleCancel(actionId: string) {
    try {
      setOperatingId(actionId);
      const res = await fetch(`/api/debug/actions/${actionId}/cancel`, { method: "POST" });
      const payload = await res.json();
      handleApiAccess(res, payload, "Không thể hủy action.");
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
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
        body: JSON.stringify({ confirmedBy: session.actor }),
      });
      const json = await res.json();
      handleApiAccess(res, json, "Không thể xác nhận delivery.");
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
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
    <main id="main-content" tabIndex={-1} className="min-h-dvh bg-slate-950 text-slate-100 p-6 max-w-6xl mx-auto space-y-8">
      <header className="border-b border-slate-800 pb-4 flex items-center justify-between">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs font-semibold uppercase tracking-wider mb-2">
            Trung tâm thông báo và kiểm soát action
          </div>
          <h1 className="text-3xl font-extrabold text-slate-100">Trung tâm thông báo</h1>
          <p className="text-sm text-slate-400">
            Theo dõi hàng đợi gửi bất đồng bộ, trạng thái nhà cung cấp và lịch sử xử lý.
          </p>
        </div>
        <button
          onClick={loadData}
          className="px-4 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-semibold rounded-xl text-slate-300 transition"
        >
          Làm mới hàng đợi
        </button>
      </header>

      {error && <p role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-100">{error}</p>}
      {!session.loading && !session.can("MANAGE_SYSTEM") && <p role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-100">Vai trò {session.role} được xem hàng đợi nhưng không có quyền retry, cancel hoặc xác nhận delivery.</p>}

      {/* Provider Health Section */}
      <section className="space-y-3">
        <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider">Nhà cung cấp thông báo</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {providers.map((p) => (
            <div key={p.name} className="p-4 bg-slate-900 border border-slate-800 rounded-2xl flex items-center justify-between">
              <div>
                <span className="font-bold text-sm text-slate-100 capitalize block">{p.name} Provider</span>
                <span className="text-xs text-slate-400 block mt-0.5">{p.details || "Sẵn sàng"}</span>
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
                {providerStatusLabel[p.status]||p.status}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 sm:grid-cols-7 gap-2 text-xs">
        <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
          <span className="text-slate-400 block font-semibold">Tổng action</span>
          <span className="text-lg font-bold text-slate-100 mt-1 block">{metrics.total || 0}</span>
        </div>
        <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
          <span className="text-amber-400 block font-semibold">Đang chờ</span>
          <span className="text-lg font-bold text-amber-300 mt-1 block">{metrics.pending || 0}</span>
        </div>
        <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
          <span className="text-blue-400 block font-semibold">Đang xử lý</span>
          <span className="text-lg font-bold text-blue-300 mt-1 block">{metrics.processing || 0}</span>
        </div>
        <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
          <span className="text-emerald-400 block font-semibold">Đã gửi</span>
          <span className="text-lg font-bold text-emerald-300 mt-1 block">{metrics.sent || 0}</span>
        </div>
        <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
          <span className="text-purple-400 block font-semibold">Mô phỏng</span>
          <span className="text-lg font-bold text-purple-300 mt-1 block">{metrics.simulated || 0}</span>
        </div>
        <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
          <span className="text-rose-400 block font-semibold">Thất bại</span>
          <span className="text-lg font-bold text-rose-300 mt-1 block">{metrics.failed || 0}</span>
        </div>
        <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
          <span className="text-slate-500 block font-semibold">Đã hủy</span>
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
          placeholder="Tìm theo action, nhà cung cấp hoặc đối tượng..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full sm:w-64 px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
        />
      </div>

      {/* Action Queue List */}
      {loading ? (
        <div className="p-8 text-center text-slate-500 animate-pulse">Đang tải hàng đợi action…</div>
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
                      {actionStatusLabel[a.status]||a.status}
                    </span>

                    {isSimulated && session.can("MANAGE_SYSTEM") && (
                      <button
                        onClick={() => handleConfirmSimulated(a.id)}
                        disabled={operatingId === a.id}
                        className="px-3 py-1 bg-indigo-500 hover:bg-indigo-400 text-slate-950 font-bold text-xs rounded-xl shadow transition"
                      >
                        {operatingId === a.id ? "Đang xác nhận…" : "Xác nhận delivery"}
                      </button>
                    )}

                    {isFailed && session.can("MANAGE_SYSTEM") && (
                      <button
                        onClick={() => handleRetry(a.id)}
                        disabled={operatingId === a.id}
                        className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs rounded-xl shadow transition"
                      >
                        {operatingId === a.id ? "Đang thử lại…" : "Thử gửi lại"}
                      </button>
                    )}

                    {isPending && session.can("MANAGE_SYSTEM") && (
                      <button
                        onClick={() => handleCancel(a.id)}
                        disabled={operatingId === a.id}
                        className="px-3 py-1 bg-rose-500/20 hover:bg-rose-500/30 text-rose-400 border border-rose-500/30 font-semibold text-xs rounded-xl transition"
                      >
                        {operatingId === a.id ? "Đang hủy…" : "Hủy"}
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs text-slate-400">
                  <div>
                    <span className="block text-slate-500">Đối tượng</span>
                    <span className="text-slate-200 font-medium">{a.target_type}:{a.target_id || "global"}</span>
                  </div>
                  <div>
                    <span className="block text-slate-500">Kết quả</span>
                    <span className="text-slate-200 font-medium uppercase">{a.outcome || a.status}</span>
                  </div>
                  <div>
                    <span className="block text-slate-500">Mã thông điệp</span>
                    <span className="text-slate-200 font-mono text-[11px] truncate block">
                      {a.provider_message_id || "N/A"}
                    </span>
                  </div>
                  <div>
                    <span className="block text-slate-500">Số lần thử lại</span>
                    <span className="text-slate-200 font-medium">{a.retry_count} / {a.max_retry}</span>
                  </div>
                  <div>
                    <span className="block text-slate-500">Thông tin khóa</span>
                    <span className="text-slate-300 font-mono text-[11px] truncate block">
                      {a.locked_by ? `${a.locked_by}` : "Không khóa"}
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
                      Xem payload và phản hồi nhà cung cấp
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
              Không có action thông báo phù hợp bộ lọc.
            </div>
          )}
        </div>
      )}
    </main>
  );
}
