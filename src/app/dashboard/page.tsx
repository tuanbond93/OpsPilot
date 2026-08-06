"use client";

import { useState, useEffect, useCallback } from "react";

interface KPIs {
  activeIncidents: number;
  criticalRiskIncidents: number;
  highPriorityIncidents: number;
  averageIncidentDurationHours: number;
  averageOldestOrderAgeHours: number;
  incidentsResolvedToday: number;
  aiJobsPending: number;
  aiJobsRunning: number;
  notificationsPending: number;
  notificationsFailed: number;
  followupsWaiting: number;
  plannerDraftsWaitingReview: number;
}

interface IncidentItem {
  incidentId: string;
  incidentKey: string;
  warehouseId: string;
  warehouseName: string;
  reasonCode: string;
  reasonName: string;
  priorityScore: number;
  affectedOrderCount: number;
  averageAgeHours: number;
  maximumAgeHours: number;
  risk: { score: number; level: "low" | "medium" | "high" | "critical" };
  trend: "improving" | "stagnant" | "worsening" | "insufficient_data";
  followupState: string;
  plannerStatus: string;
  aiStatus: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
}

interface WorkerStatus {
  pendingCount: number;
  processingCount: number;
  completedTodayCount: number;
  failedTodayCount: number;
  retryQueueCount: number;
  workerHealth: "healthy" | "degraded" | "idle";
  lastExecution: string | null;
  averageRuntimeMs: number;
  queueDepth: number;
}

interface BoundedPayload<T> {
  items: T[];
  totalCount: number;
  displayedCount: number;
  hasMore: boolean;
}

interface FollowupSummaryItem {
  incidentKey: string;
  currentState: string;
  nextActionAt: string | null;
  lastCheckedAt: string | null;
  progressPercent: number;
  progressAssessment: string;
}

interface NotificationActionItem {
  id: string;
  actionType: string;
  provider: string;
  targetType: string;
  targetId: string;
  status: string;
  outcome: string | null;
  retryCount: number;
  lastError: string | null;
  createdAt: string;
}

interface PlannerRecommendationItem {
  id: string;
  runId: string;
  incidentId: string;
  title: string;
  type: string;
  targetRole: string;
  priority: "high" | "medium" | "low";
  confidenceScore: number;
  status: "DRAFT" | "APPROVED" | "REJECTED" | "EXPIRED";
}

interface TimelineItem {
  eventId: string;
  eventType: string;
  source: string;
  occurredAt: string;
  entityId: string;
  title: string;
  description: string;
  actor: string | null;
}

interface HealthIndicator {
  status: "green" | "yellow" | "red" | "unknown";
  healthReason: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  freshnessSeconds: number | null;
}

interface SystemHealth {
  database: HealthIndicator;
  aiWorker: HealthIndicator;
  notificationPlatform: HealthIndicator;
  aiProvider: HealthIndicator;
  cronWorker: HealthIndicator;
  lastSync: string | null;
  lastAiWorker: string | null;
  lastNotificationDispatch: string | null;
}

interface DiagnosticsTimings {
  incidentsMs: number;
  historiesMs: number;
  followupsMs: number;
  plannerMs: number;
  aiJobsMs: number;
  notificationsMs: number;
  syncRunMs: number;
  aggregationMs: number;
  totalMs: number;
}

interface DashboardData {
  ok: boolean;
  dataFreshness: string;
  source: string;
  scope: { configuredScope: string; appliedWarehouseFilter: string };
  writeControlsEnabled: boolean;
  kpis: KPIs;
  incidents: BoundedPayload<IncidentItem>;
  workerStatus: WorkerStatus;
  followups: BoundedPayload<FollowupSummaryItem> & {
    totalCases: number;
    resolvedCases: number;
    escalatedCases: number;
    pendingConfirmationCount: number;
  };
  notifications: BoundedPayload<NotificationActionItem> & {
    pending: number;
    processing: number;
    sent: number;
    simulated: number;
    failed: number;
    cancelled: number;
  };
  plannerSummary: {
    draftCount: number;
    approvedCount: number;
    rejectedCount: number;
    recentRecommendations: BoundedPayload<PlannerRecommendationItem>;
  };
  health: SystemHealth;
  timeline: BoundedPayload<TimelineItem>;
  diagnostics?: { timings: DiagnosticsTimings };
}

export default function ExecutiveDashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Warehouse Scope & Search/Filters
  const [selectedScope, setSelectedScope] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [filterReason, setFilterReason] = useState<string>("all");
  const [filterRisk, setFilterRisk] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"priority" | "age" | "risk" | "newest">("priority");

  // Notification action message
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const fetchDashboardData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const url = `/api/dashboard?scope=${encodeURIComponent(selectedScope)}`;
      const res = await fetch(url);
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.message || json.error || "Failed to load dashboard data");
      }
      setData(json);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [selectedScope]);

  useEffect(() => {
    fetchDashboardData();
    const interval = setInterval(fetchDashboardData, 30000);
    return () => clearInterval(interval);
  }, [fetchDashboardData]);

  async function handleNotificationAction(actionId: string, op: "retry" | "cancel") {
    if (!data?.writeControlsEnabled) {
      alert("Write controls are disabled in production environment.");
      return;
    }

    const actor = prompt("Nhập tên/mã người thực hiện (actor):", "operator@ops.vn");
    if (!actor || !actor.trim()) return;

    const confirmed = confirm(`Xác nhận thực hiện thao tác ${op.toUpperCase()} cho Action #${actionId}?`);
    if (!confirmed) return;

    try {
      setActionMessage(null);
      const endpoint = `/api/debug/actions/${encodeURIComponent(actionId)}/${op}`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: actor.trim(), reason: `Operator manual ${op}` }),
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        throw new Error(json.message || json.error || `${op} failed`);
      }
      setActionMessage(`Thao tác ${op.toUpperCase()} thành công bởi ${actor}`);
      fetchDashboardData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Action error: ${msg}`);
    }
  }

  async function handlePlannerReview(runId: string, decision: "APPROVED" | "REJECTED") {
    if (!data?.writeControlsEnabled) {
      alert("Write controls are disabled in production environment.");
      return;
    }

    const reviewer = prompt("Nhập tên/mã người phê duyệt (reviewedBy):", "operator@ops.vn");
    if (!reviewer || !reviewer.trim()) return;

    const confirmed = confirm(`Xác nhận ${decision === "APPROVED" ? "PHÊ DUYỆT" : "TỪ CHỐI"} Planner Run #${runId}?`);
    if (!confirmed) return;

    try {
      setActionMessage(null);
      const res = await fetch(`/api/debug/planner-runs/${encodeURIComponent(runId)}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reviewedBy: reviewer.trim() }),
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        throw new Error(json.message || json.error || "Review failed");
      }
      setActionMessage(`Đã ${decision === "APPROVED" ? "PHÊ DUYỆT" : "TỪ CHỐI"} bởi ${reviewer}`);
      fetchDashboardData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Review error: ${msg}`);
    }
  }

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 p-6 max-w-7xl mx-auto space-y-6 animate-pulse">
        <div className="h-10 bg-slate-900 rounded-xl w-1/3"></div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-24 bg-slate-900 rounded-2xl"></div>
          ))}
        </div>
        <div className="h-96 bg-slate-900 rounded-2xl"></div>
      </div>
    );
  }

  const kpis = data?.kpis;
  const incidentsPayload = data?.incidents;
  const incidents = incidentsPayload?.items || [];
  const worker = data?.workerStatus;
  const followups = data?.followups;
  const notifications = data?.notifications;
  const planner = data?.plannerSummary;
  const health = data?.health;
  const timelinePayload = data?.timeline;
  const timeline = timelinePayload?.items || [];
  const timings = data?.diagnostics?.timings;

  const reasonsList = Array.from(new Set(incidents.map((i) => i.reasonName)));

  const filteredIncidents = incidents.filter((inc) => {
    if (filterReason !== "all" && inc.reasonName !== filterReason) return false;
    if (filterRisk !== "all" && inc.risk.level !== filterRisk) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchKey = inc.incidentKey.toLowerCase().includes(q);
      const matchWh = inc.warehouseName.toLowerCase().includes(q);
      const matchReason = inc.reasonName.toLowerCase().includes(q);
      if (!matchKey && !matchWh && !matchReason) return false;
    }
    return true;
  });

  filteredIncidents.sort((a, b) => {
    if (sortBy === "priority") return b.priorityScore - a.priorityScore;
    if (sortBy === "age") return b.maximumAgeHours - a.maximumAgeHours;
    if (sortBy === "risk") return b.risk.score - a.risk.score;
    if (sortBy === "newest") return new Date(b.firstDetectedAt).getTime() - new Date(a.firstDetectedAt).getTime();
    return 0;
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 max-w-7xl mx-auto space-y-8">
      {/* Header & Health Monitor */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-semibold uppercase tracking-wider mb-2">
            OpsPilot Executive Control Center (Hardened)
          </div>
          <h1 className="text-3xl font-extrabold text-slate-100">Operations Control Center</h1>
          <p className="text-sm text-slate-400">
            Real-time Operational Governance • Bounded Payloads • Immutable Timeline
          </p>
        </div>

        {/* Scope, Controls Governance & Health Indicators */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl text-xs">
            <span className="text-slate-400 font-semibold">Scope:</span>
            <select
              value={selectedScope}
              onChange={(e) => setSelectedScope(e.target.value)}
              className="bg-slate-950 border border-slate-800 text-slate-200 px-2 py-0.5 rounded font-mono font-bold"
            >
              <option value="all">All Warehouses (Global)</option>
              <option value="WH-HN-01">Kho HN-01</option>
              <option value="WH-HCM-01">Kho HCM-01</option>
              <option value="WH-DN-01">Kho DN-01</option>
            </select>
          </div>

          <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl text-xs">
            <span className="text-slate-400 font-semibold">System Health:</span>
            <div className="flex items-center gap-1.5 font-mono">
              <span title={`Database: ${health?.database?.healthReason}`} className={`w-2.5 h-2.5 rounded-full ${health?.database?.status === "green" ? "bg-emerald-400" : "bg-rose-500"}`}></span>
              <span title={`AI Worker: ${health?.aiWorker?.healthReason}`} className={`w-2.5 h-2.5 rounded-full ${health?.aiWorker?.status === "green" ? "bg-emerald-400" : health?.aiWorker?.status === "yellow" ? "bg-amber-400" : "bg-rose-500"}`}></span>
              <span title={`Notification Platform: ${health?.notificationPlatform?.healthReason}`} className={`w-2.5 h-2.5 rounded-full ${health?.notificationPlatform?.status === "green" ? "bg-emerald-400" : "bg-amber-400"}`}></span>
              <span title={`Cron Worker: ${health?.cronWorker?.healthReason}`} className={`w-2.5 h-2.5 rounded-full ${health?.cronWorker?.status === "green" ? "bg-emerald-400" : "bg-amber-400"}`}></span>
            </div>
          </div>

          <button
            onClick={fetchDashboardData}
            className="px-4 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 text-xs font-semibold rounded-xl transition flex items-center gap-1.5"
          >
            🔄 Refresh ({timings?.totalMs || 0}ms)
          </button>
        </div>
      </header>

      {actionMessage && (
        <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs rounded-xl font-semibold flex items-center justify-between">
          <span>{actionMessage}</span>
          <button onClick={() => setActionMessage(null)} className="text-slate-400 hover:text-slate-200">✕</button>
        </div>
      )}

      {error && (
        <div className="p-4 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs rounded-xl font-semibold">
          🚨 {error}
        </div>
      )}

      {/* SECTION 1: EXECUTIVE KPI HEADER */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Chỉ Số Vận Hành Chính (Executive KPIs)</h2>
          {!data?.writeControlsEnabled && (
            <span className="text-[11px] text-amber-400 font-mono bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
              🔒 Write Controls Disabled (Production Read-Only)
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
          <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl space-y-1">
            <span className="text-slate-400 font-semibold">Active Incidents</span>
            <span className="text-2xl font-extrabold text-amber-400 block font-mono">{kpis?.activeIncidents || 0}</span>
          </div>

          <div className="p-4 bg-slate-900 border border-rose-500/30 rounded-2xl space-y-1">
            <span className="text-rose-400 font-semibold">Critical Risk Incidents</span>
            <span className="text-2xl font-extrabold text-rose-400 block font-mono">{kpis?.criticalRiskIncidents || 0}</span>
          </div>

          <div className="p-4 bg-slate-900 border border-amber-500/30 rounded-2xl space-y-1">
            <span className="text-amber-400 font-semibold">High Priority Incidents</span>
            <span className="text-2xl font-extrabold text-amber-400 block font-mono">{kpis?.highPriorityIncidents || 0}</span>
          </div>

          <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl space-y-1">
            <span className="text-slate-400 font-semibold">Avg Duration</span>
            <span className="text-2xl font-extrabold text-slate-100 block font-mono">{kpis?.averageIncidentDurationHours || 0}h</span>
          </div>

          <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl space-y-1">
            <span className="text-slate-400 font-semibold">Avg Oldest Order Age</span>
            <span className="text-2xl font-extrabold text-slate-100 block font-mono">{kpis?.averageOldestOrderAgeHours || 0}h</span>
          </div>

          <div className="p-4 bg-slate-900 border border-emerald-500/30 rounded-2xl space-y-1">
            <span className="text-emerald-400 font-semibold">Resolved Today</span>
            <span className="text-2xl font-extrabold text-emerald-400 block font-mono">{kpis?.incidentsResolvedToday || 0}</span>
          </div>

          <div className="p-4 bg-slate-900 border border-purple-500/30 rounded-2xl space-y-1">
            <span className="text-purple-400 font-semibold">AI Jobs Running</span>
            <span className="text-2xl font-extrabold text-purple-400 block font-mono">
              {kpis?.aiJobsRunning || 0} <span className="text-xs font-normal text-slate-500">({kpis?.aiJobsPending || 0} pending)</span>
            </span>
          </div>

          <div className="p-4 bg-slate-900 border border-rose-500/30 rounded-2xl space-y-1">
            <span className="text-rose-400 font-semibold">Notifications Failed</span>
            <span className="text-2xl font-extrabold text-rose-400 block font-mono">{kpis?.notificationsFailed || 0}</span>
          </div>

          <div className="p-4 bg-slate-900 border border-indigo-500/30 rounded-2xl space-y-1">
            <span className="text-indigo-400 font-semibold">Follow-ups Waiting</span>
            <span className="text-2xl font-extrabold text-indigo-400 block font-mono">{kpis?.followupsWaiting || 0}</span>
          </div>

          <div className="p-4 bg-slate-900 border border-amber-500/30 rounded-2xl space-y-1">
            <span className="text-amber-400 font-semibold">Planner Drafts</span>
            <span className="text-2xl font-extrabold text-amber-400 block font-mono">{kpis?.plannerDraftsWaitingReview || 0}</span>
          </div>
        </div>
      </section>

      {/* SECTION 2: LIVE INCIDENT BOARD */}
      <section className="bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-6 shadow-xl">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
              Live Incident Board
              <span className="text-xs font-normal text-slate-400 font-mono">
                ({incidentsPayload?.displayedCount || 0}/{incidentsPayload?.totalCount || 0} items)
              </span>
            </h2>
            <p className="text-xs text-slate-400">Danh sách các sự cố vận hành đang hoạt động (Scope: {selectedScope})</p>
          </div>

          {/* Search & Sort */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <input
              type="text"
              placeholder="Search key, warehouse..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-slate-950 border border-slate-800 text-slate-200 px-3 py-1.5 rounded-xl focus:outline-none focus:border-blue-500"
            />

            <select
              value={filterReason}
              onChange={(e) => setFilterReason(e.target.value)}
              className="bg-slate-950 border border-slate-800 text-slate-200 px-3 py-1.5 rounded-xl"
            >
              <option value="all">All Reasons</option>
              {reasonsList.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>

            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="bg-slate-950 border border-slate-800 text-slate-200 px-3 py-1.5 rounded-xl font-semibold"
            >
              <option value="priority">Sort: Priority</option>
              <option value="age">Sort: Max Age</option>
              <option value="risk">Sort: Risk Score</option>
              <option value="newest">Sort: Newest</option>
            </select>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 font-semibold uppercase tracking-wider">
                <th className="py-3 px-2">Kho Hàng</th>
                <th className="py-3 px-2">Loại Sự Cố</th>
                <th className="py-3 px-2">Ưu Tiên</th>
                <th className="py-3 px-2">Rủi Ro</th>
                <th className="py-3 px-2">Xu Hướng</th>
                <th className="py-3 px-2">Đơn Hàng</th>
                <th className="py-3 px-2">Tuổi Thọ Max</th>
                <th className="py-3 px-2">Follow-up State</th>
                <th className="py-3 px-2">Planner Status</th>
                <th className="py-3 px-2">AI Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {filteredIncidents.map((inc) => (
                <tr key={inc.incidentId} className="hover:bg-slate-800/30 transition">
                  <td className="py-3 px-2 font-bold text-slate-200">{inc.warehouseName}</td>
                  <td className="py-3 px-2 text-amber-400">{inc.reasonName}</td>
                  <td className="py-3 px-2 font-mono font-bold">{inc.priorityScore}</td>
                  <td className="py-3 px-2">
                    <span
                      className={`px-2 py-0.5 rounded font-mono font-bold text-[10px] uppercase ${
                        inc.risk.level === "critical"
                          ? "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                          : inc.risk.level === "high"
                          ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                          : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                      }`}
                    >
                      {inc.risk.level} ({inc.risk.score})
                    </span>
                  </td>
                  <td className="py-3 px-2 font-mono">
                    <span className={inc.trend === "improving" ? "text-emerald-400" : inc.trend === "worsening" ? "text-rose-400" : "text-slate-400"}>
                      {inc.trend}
                    </span>
                  </td>
                  <td className="py-3 px-2 font-mono font-bold">{inc.affectedOrderCount} đơn</td>
                  <td className="py-3 px-2 font-mono">{inc.maximumAgeHours}h</td>
                  <td className="py-3 px-2 font-mono text-purple-400">{inc.followupState}</td>
                  <td className="py-3 px-2 font-mono">
                    <span className={inc.plannerStatus === "APPROVED" ? "text-emerald-400" : inc.plannerStatus === "DRAFT" ? "text-amber-400" : "text-slate-400"}>
                      {inc.plannerStatus}
                    </span>
                  </td>
                  <td className="py-3 px-2 font-mono">
                    <span className={inc.aiStatus === "COMPLETED" ? "text-emerald-400" : inc.aiStatus === "PROCESSING" || inc.aiStatus === "PENDING" ? "text-amber-400" : "text-slate-400"}>
                      {inc.aiStatus}
                    </span>
                  </td>
                </tr>
              ))}

              {filteredIncidents.length === 0 && (
                <tr>
                  <td colSpan={10} className="py-8 text-center text-slate-500">
                    Không tìm thấy sự cố phù hợp với bộ lọc.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* SECTION 3 & 4: AI WORKER STATUS & FOLLOWUP */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* SECTION 3: AI WORKER STATUS */}
        <section className="bg-slate-900 border border-purple-500/30 p-6 rounded-2xl space-y-4 shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-purple-400"></span> AI Background Worker Status
            </h2>
            <span className={`px-2.5 py-0.5 rounded text-xs font-mono font-bold uppercase ${worker?.workerHealth === "healthy" ? "bg-emerald-500/20 text-emerald-400" : "bg-amber-500/20 text-amber-400"}`}>
              {worker?.workerHealth || "idle"}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
              <span className="text-slate-400 block font-semibold">Pending</span>
              <span className="text-lg font-bold text-amber-400 font-mono mt-0.5 block">{worker?.pendingCount || 0}</span>
            </div>
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
              <span className="text-slate-400 block font-semibold">Processing</span>
              <span className="text-lg font-bold text-purple-400 font-mono mt-0.5 block">{worker?.processingCount || 0}</span>
            </div>
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
              <span className="text-slate-400 block font-semibold">Completed Today</span>
              <span className="text-lg font-bold text-emerald-400 font-mono mt-0.5 block">{worker?.completedTodayCount || 0}</span>
            </div>
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
              <span className="text-slate-400 block font-semibold">Failed Today</span>
              <span className="text-lg font-bold text-rose-400 font-mono mt-0.5 block">{worker?.failedTodayCount || 0}</span>
            </div>
          </div>
        </section>

        {/* SECTION 4: FOLLOW-UP STATE MACHINE */}
        <section className="bg-slate-900 border border-indigo-500/30 p-6 rounded-2xl space-y-4 shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-indigo-400"></span> Follow-up State Machine
            </h2>
            <span className="text-xs text-slate-400 font-mono">Total Cases: {followups?.totalCases || 0}</span>
          </div>

          <div className="grid grid-cols-3 gap-3 text-xs">
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
              <span className="text-slate-400 block font-semibold">Resolved Cases</span>
              <span className="text-lg font-bold text-emerald-400 font-mono mt-0.5 block">{followups?.resolvedCases || 0}</span>
            </div>
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
              <span className="text-slate-400 block font-semibold">Escalated Cases</span>
              <span className="text-lg font-bold text-rose-400 font-mono mt-0.5 block">{followups?.escalatedCases || 0}</span>
            </div>
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
              <span className="text-slate-400 block font-semibold">Pending Confirm</span>
              <span className="text-lg font-bold text-amber-400 font-mono mt-0.5 block">{followups?.pendingConfirmationCount || 0}</span>
            </div>
          </div>
        </section>
      </div>

      {/* SECTION 5 & 6: NOTIFICATION CENTER & PLANNER RECOMMENDATIONS */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* SECTION 5: NOTIFICATION CENTER */}
        <section className="bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-4 shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400"></span> Notification Platform Center
            </h2>
            <span className="text-xs text-slate-400 font-mono">
              ({notifications?.displayedCount || 0}/{notifications?.totalCount || 0} actions)
            </span>
          </div>

          <div className="space-y-2 text-xs">
            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
              {notifications?.items.map((act) => (
                <div key={act.id} className="p-2.5 bg-slate-950 border border-slate-800 rounded-xl flex items-center justify-between">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2 font-mono text-[11px]">
                      <span className="font-bold text-slate-200">{act.actionType}</span>
                      <span className="text-slate-400">({act.provider})</span>
                      <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold ${act.status === "SENT" ? "bg-emerald-500/20 text-emerald-400" : act.status === "FAILED" ? "bg-rose-500/20 text-rose-400" : "bg-amber-500/20 text-amber-400"}`}>
                        {act.status}
                      </span>
                    </div>
                  </div>

                  {data?.writeControlsEnabled && (
                    <div className="flex items-center gap-1.5">
                      {act.status === "FAILED" && (
                        <button onClick={() => handleNotificationAction(act.id, "retry")} className="px-2 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded text-[10px] font-bold">
                          Retry
                        </button>
                      )}
                      {["PENDING", "PROCESSING"].includes(act.status) && (
                        <button onClick={() => handleNotificationAction(act.id, "cancel")} className="px-2 py-1 bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 rounded text-[10px] font-bold">
                          Cancel
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* SECTION 6: PLANNER RECOMMENDATIONS */}
        <section className="bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-4 shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-purple-400"></span> Action Planner Recommendations
            </h2>
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="text-amber-400">Draft: {planner?.draftCount || 0}</span>
              <span className="text-emerald-400">Approved: {planner?.approvedCount || 0}</span>
            </div>
          </div>

          <div className="space-y-3 max-h-72 overflow-y-auto pr-1 text-xs">
            {planner?.recentRecommendations.items.map((rec) => (
              <div key={rec.id} className="p-3 bg-slate-950 border border-slate-800 rounded-xl space-y-2">
                <div className="flex items-center justify-between border-b border-slate-900 pb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 font-mono text-[9px] font-bold">
                      {rec.type}
                    </span>
                    <span className="font-bold text-slate-200">{rec.title}</span>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-[9px] font-bold font-mono ${rec.status === "APPROVED" ? "bg-emerald-500/20 text-emerald-400" : rec.status === "REJECTED" ? "bg-rose-500/20 text-rose-400" : "bg-amber-500/20 text-amber-400"}`}>
                    {rec.status}
                  </span>
                </div>

                {rec.status === "DRAFT" && data?.writeControlsEnabled && (
                  <div className="flex items-center justify-end gap-2 pt-1 border-t border-slate-900">
                    <button onClick={() => handlePlannerReview(rec.runId, "REJECTED")} className="px-3 py-1 bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-[10px] font-bold rounded">
                      Reject
                    </button>
                    <button onClick={() => handlePlannerReview(rec.runId, "APPROVED")} className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold rounded">
                      Approve
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* SECTION 7: UNIFIED IMMUTABLE TIMELINE */}
      <section className="bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-4 shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
            <span>📜</span> Unified Operational Timeline (Immutable Event Log)
          </h2>
          <span className="text-xs text-slate-400 font-mono">
            ({timelinePayload?.displayedCount || 0}/{timelinePayload?.totalCount || 0} events)
          </span>
        </div>

        <div className="space-y-3 max-h-80 overflow-y-auto pr-1 text-xs">
          {timeline.map((item) => (
            <div key={item.eventId} className="p-3 bg-slate-950 border border-slate-800 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded font-mono text-[9px] font-bold uppercase bg-blue-500/20 text-blue-400">
                    {item.eventType}
                  </span>
                  <span className="font-bold text-slate-200">{item.title}</span>
                </div>
                <p className="text-slate-400 text-[11px]">{item.description}</p>
              </div>

              <div className="flex items-center gap-3 text-right">
                <span className="font-mono text-[10px] text-slate-500">
                  {new Date(item.occurredAt).toLocaleTimeString()}
                </span>
                <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-300 font-mono text-[10px]">
                  {item.actor || "system"}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
