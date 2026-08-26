"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { Minus, TrendingDown, TrendingUp, CircleHelp } from "lucide-react";
import { incidentRuleExplanation, incidentSignalLabel, repairOperationalText, translateStatus } from "@/app/_components/operationalText";
import { handleApiAccess } from "@/app/_components/apiAccess";
import { useOpsSession } from "@/app/_components/useOpsSession";

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
  oldestOrderCode?: string | null;
  sampleOrderCodes?: string[];
  risk: { score: number; level: "low" | "medium" | "high" | "critical" };
  trend: "improving" | "stagnant" | "worsening" | "insufficient_data";
  previousAffectedOrderCount?: number | null;
  latestSnapshotAt?: string | null;
  previousSnapshotAt?: string | null;
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

interface ShadowFollowupRunItem {
  eventId: string;
  decisionId: string;
  actor: string;
  occurredAt: string;
  observationState: "READY_TO_VERIFY" | "AWAITING_POST_WINDOW_EVIDENCE";
  observedAt: string | null;
  observedAffectedOrders: number | null;
  source: string | null;
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

interface CopilotReviewSummary {
  pending: number;
  total: number;
  unavailable: boolean;
}

interface AccountScope {
  mode: "ALL" | "ASSIGNED" | "UNASSIGNED";
  employeeId: string | null;
  warehouseCount: number;
  zones: string[];
  pics: Array<{ employeeId: string; name: string; title: string }>;
  warehouses: Array<{ warehouseId: string; warehouseName: string; warehouseType: string; province: string; zone: string; picIds: string[] }>;
}

const syncPhaseLabels: Record<string, string> = {
  CREATED: "Chuẩn bị đồng bộ",
  FETCHING_SNAPSHOT: "Đang lấy dữ liệu nguồn",
  PERSISTING_SNAPSHOTS: "Đang lưu đơn cần theo dõi",
  PERSISTING_INCIDENTS: "Đang cập nhật sự cố",
  PERSISTING_HISTORY: "Đang lưu lịch sử",
  PROCESSING_FOLLOWUPS: "Đang đánh giá follow-up",
  ENQUEUE_NOTIFICATIONS: "Đang chuẩn bị thông báo",
  ENQUEUE_AI: "Đang xếp hàng phân tích AI",
  REFRESHING_PROJECTIONS: "Đang cập nhật dashboard",
  COMPLETED: "Đã hoàn tất",
  FAILED: "Đồng bộ thất bại",
};

const notificationActionLabels: Record<string, string> = {
  DISPATCH: "Gửi thông báo",
  RETRY: "Gửi lại thông báo",
  CANCEL: "Hủy thông báo",
};

const notificationProviderLabels: Record<string, string> = {
  console: "Bảng điều khiển",
  telegram: "Telegram",
};

const notificationStatusLabels: Record<string, string> = {
  PENDING: "CHỜ GỬI",
  PROCESSING: "ĐANG GỬI",
  SENT: "ĐÃ GỬI",
  SIMULATED: "MÔ PHỎNG",
  FAILED: "GỬI THẤT BẠI",
  CANCELLED: "ĐÃ HỦY",
};

const plannerRecommendationLabels: Record<string, string> = {
  PRIORITIZE_OLD_ORDERS: "Ưu tiên đơn tồn lâu",
  VERIFY_EXCEPTION: "Xác minh ngoại lệ",
  REVIEW_ASSIGNMENT: "Kiểm tra phân công",
  CONTACT_WAREHOUSE: "Liên hệ kho",
  PREPARE_ESCALATION: "Chuẩn bị hồ sơ leo thang",
  CONTINUE_MONITORING: "Tiếp tục theo dõi",
  NO_ACTION: "Chưa cần hành động",
};

function priorityPresentation(score: number) {
  if (score >= 75) return { label: "Rất cao", tone: "border-rose-500/40 bg-rose-500/10 text-rose-200" };
  if (score >= 50) return { label: "Cao", tone: "border-amber-500/40 bg-amber-500/10 text-amber-200" };
  return { label: "Theo dõi", tone: "border-sky-500/40 bg-sky-500/10 text-sky-200" };
}

const PRIORITY_REASON_WEIGHTS: Record<string, number> = {
  "Kho tồn": 1.5,
  "Kho chưa lấy": 1.3,
  "Thiếu shipper": 1.2,
  "Kho chưa luân chuyển": 1,
};

function priorityEvidence(reason: string, orderCount: number, maximumAgeHours: number | null) {
  const countFactor = Math.min(orderCount * 2, 100);
  const ageFactor = Math.min((maximumAgeHours ?? 0) * 0.5, 50);
  const weight = PRIORITY_REASON_WEIGHTS[repairOperationalText(reason)] ?? 1;
  return `${countFactor} điểm quy mô + ${Math.round(ageFactor * 10) / 10} điểm độ lâu, nhân trọng số ${weight}`;
}

function observableSignalEvidence(reason: string, orderCount: number, maximumAgeHours: number | null) {
  const normalizedReason = repairOperationalText(reason);
  const age = maximumAgeHours === null ? "chưa có dữ liệu tuổi" : `đơn lâu nhất ${maximumAgeHours} giờ`;
  const status = normalizedReason === "Kho tồn" ? "storing" : normalizedReason === "Kho chưa lấy" ? "ready_to_pick" : normalizedReason === "Kho chưa luân chuyển" ? "transporting" : normalizedReason === "Thiếu shipper" ? "delivering" : "khớp rule";
  return `${orderCount} đơn có trạng thái ${status}; ${age}. Chưa có dữ liệu để kết luận thiếu người, quá tải hoặc nguyên nhân gốc khác.`;
}

export default function ExecutiveDashboardPage() {
  const session = useOpsSession();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [copilotReviews, setCopilotReviews] = useState<CopilotReviewSummary>({
    pending: 0,
    total: 0,
    unavailable: false,
  });

  // Warehouse Scope & Search/Filters
  const [accountScope, setAccountScope] = useState<AccountScope | null>(null);
  const [selectedZone, setSelectedZone] = useState("");
  const [selectedPic, setSelectedPic] = useState("");
  const [selectedWarehouse, setSelectedWarehouse] = useState("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [filterReason, setFilterReason] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"priority" | "age" | "newest">("priority");

  // Notification action message
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncElapsedSeconds, setSyncElapsedSeconds] = useState(0);
  const [syncPhase, setSyncPhase] = useState("CREATED");
  const [shadowRuns, setShadowRuns] = useState<ShadowFollowupRunItem[]>([]);
  const [shadowRunning, setShadowRunning] = useState(false);
  const [shadowRunMessage, setShadowRunMessage] = useState<string | null>(null);

  const fetchShadowRuns = useCallback(async () => {
    try {
      const response = await fetch("/api/decision-followups/shadow-runs", { cache: "no-store" });
      const result = await response.json();
      handleApiAccess(response, result, "Không thể tải lịch sử LC-10.");
      setShadowRuns(result.data || []);
    } catch {
      setShadowRuns([]);
    }
  }, []);

  const selectedScope = selectedWarehouse
    ? selectedWarehouse
    : selectedPic
      ? `pic:${selectedPic}`
      : selectedZone
        ? `zone:${selectedZone}`
        : "all";

  const visibleWarehouses = useMemo(() => (accountScope?.warehouses || []).filter((warehouse) =>
    (!selectedZone || warehouse.zone === selectedZone) &&
    (!selectedPic || warehouse.picIds.includes(selectedPic))
  ), [accountScope, selectedPic, selectedZone]);

  const visiblePicIds = useMemo(() => new Set((accountScope?.warehouses || [])
    .filter((warehouse) => !selectedZone || warehouse.zone === selectedZone)
    .flatMap((warehouse) => warehouse.picIds)), [accountScope, selectedZone]);

  useEffect(() => {
    fetch("/api/account/scope", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() : Promise.reject(new Error("Không thể tải phạm vi tài khoản")))
      .then((scope: AccountScope) => setAccountScope(scope))
      .catch(() => setAccountScope(null));
  }, []);

  const fetchDashboardData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const url = `/api/dashboard?scope=${encodeURIComponent(selectedScope)}`;
      const res = await fetch(url);
      const json = await res.json();
      handleApiAccess(res, json, "Không thể tải dữ liệu dashboard.");
      if (!json.ok) {
        throw new Error(json.message || json.error || "Failed to load dashboard data");
      }
      setData(json);

      if (json.source === "degraded_fallback") {
        setCopilotReviews({ pending: 0, total: 0, unavailable: true });
      } else {
        const reviewChecks = await Promise.all(
          (json.incidents?.items || []).slice(0, 20).map(async (incident: IncidentItem) => {
            try {
              const response = await fetch(
                `/api/copilot/incident/${encodeURIComponent(incident.incidentId)}`,
                { cache: "no-store" }
              );
              if (!response.ok) return null;
              const result = await response.json();
              return result.activeReview?.status || "PENDING";
            } catch {
              return null;
            }
          })
        );
        const availableReviews = reviewChecks.filter((status): status is string => status !== null);
        setCopilotReviews({
          pending: availableReviews.filter((status) => status === "PENDING").length,
          total: availableReviews.length,
          unavailable: false,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [selectedScope]);

  useEffect(() => {
    fetchDashboardData();
    void fetchShadowRuns();
    const interval = setInterval(fetchDashboardData, 30000);
    return () => clearInterval(interval);
  }, [fetchDashboardData, fetchShadowRuns]);

  useEffect(() => {
    if (!syncing) return;
    setSyncElapsedSeconds(0);
    const timer = setInterval(() => setSyncElapsedSeconds((seconds) => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [syncing]);

  async function handleFreshSync() {
    if (!session.can("MANAGE_SYSTEM")) { setSyncMessage("Chỉ ADMIN được yêu cầu đồng bộ thủ công."); return; }
    setSyncMessage(null);
    setSyncPhase("FETCHING_SNAPSHOT");
    setSyncElapsedSeconds(0);
    setSyncing(true);
    try {
      const response = await fetch("/api/debug/sync", { method: "POST" });
      const result = await response.json();
      if (response.status === 409) {
        setSyncMessage("Một phiên đồng bộ khác đang chạy. Hãy thử lại sau khi phiên đó hoàn tất.");
        return;
      }
      handleApiAccess(response, result, "Đồng bộ dữ liệu thất bại.");
      if (!result.ok) throw new Error(result.message || result.error?.message || "Đồng bộ dữ liệu thất bại");
      setSyncPhase("COMPLETED");
      setSyncMessage(`Đã đồng bộ và tái tạo bằng chứng cho ${result.fetchedOrderCount} đơn, phát hiện ${result.incidentCount} sự cố trong ${Math.max(1, Math.round(result.durationMs / 1000))} giây.`);
      await fetchDashboardData();
    } catch (syncError: unknown) {
      setSyncMessage(`Không thể đồng bộ: ${syncError instanceof Error ? syncError.message : String(syncError)}`);
    } finally {
      setSyncing(false);
    }
  }

  async function handleShadowFollowupRun() {
    if (!session.can("MANAGE_SYSTEM")) { setShadowRunMessage("Chỉ ADMIN được chạy LC-10 SHADOW thủ công."); return; }
    setShadowRunMessage(null);
    setShadowRunning(true);
    try {
      const response = await fetch("/api/decision-followups/shadow-runs", { method: "POST" });
      const result = await response.json();
      handleApiAccess(response, result, "Không thể chạy LC-10 SHADOW.");
      const summary = result.data;
      setShadowRunMessage(`LC-10 SHADOW hoàn tất: quét ${summary.scannedCount}, ghi evidence ${summary.capturedCount}, chờ evidence ${summary.awaitingEvidenceCount}, lỗi ${summary.failedCount}. Không có outcome nào được tự verify.`);
      await fetchShadowRuns();
    } catch (runError: unknown) {
      setShadowRunMessage(`Không thể chạy LC-10 SHADOW: ${runError instanceof Error ? runError.message : String(runError)}`);
    } finally {
      setShadowRunning(false);
    }
  }

  async function handleNotificationAction(actionId: string, op: "retry" | "cancel") {
    if (!session.can("MANAGE_SYSTEM")) { setActionMessage("Tài khoản hiện tại không có quyền điều khiển action thông báo."); return; }
    if (!data?.writeControlsEnabled) {
      alert("Write controls are disabled in production environment.");
      return;
    }

    const confirmed = confirm(`Xác nhận thực hiện thao tác ${op.toUpperCase()} cho Action #${actionId}?`);
    if (!confirmed) return;

    try {
      setActionMessage(null);
      const endpoint = `/api/debug/actions/${encodeURIComponent(actionId)}/${op}`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: session.actor, reason: `Operator manual ${op}` }),
      });
      const json = await res.json();
      handleApiAccess(res, json, `Không thể ${op} action.`);
      if (json.error) {
        throw new Error(json.message || json.error || `${op} failed`);
      }
      setActionMessage(`Thao tác ${op.toUpperCase()} thành công bởi ${session.actor}`);
      fetchDashboardData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Action error: ${msg}`);
    }
  }

  async function handlePlannerReview(runId: string, decision: "APPROVED" | "REJECTED") {
    if (!session.can("REVIEW_COPILOT")) { setActionMessage("Tài khoản hiện tại không có quyền duyệt Planner."); return; }
    if (!data?.writeControlsEnabled) {
      alert("Write controls are disabled in production environment.");
      return;
    }

    const confirmed = confirm(`Xác nhận ${decision === "APPROVED" ? "PHÊ DUYỆT" : "TỪ CHỐI"} Planner Run #${runId}?`);
    if (!confirmed) return;

    try {
      setActionMessage(null);
      const res = await fetch(`/api/debug/planner-runs/${encodeURIComponent(runId)}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reviewedBy: session.actor }),
      });
      const json = await res.json();
      handleApiAccess(res, json, "Không thể duyệt Planner.");
      if (json.error) {
        throw new Error(json.message || json.error || "Review failed");
      }
      setActionMessage(`Đã ${decision === "APPROVED" ? "PHÊ DUYỆT" : "TỪ CHỐI"} bởi ${session.actor}`);
      fetchDashboardData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Review error: ${msg}`);
    }
  }

  if (loading && !data) {
    return (
      <main id="main-content" tabIndex={-1} className="min-h-dvh bg-slate-950 text-slate-100 p-6 max-w-7xl mx-auto space-y-6 animate-pulse motion-reduce:animate-none">
        <div className="h-10 bg-slate-900 rounded-xl w-1/3"></div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-24 bg-slate-900 rounded-2xl"></div>
          ))}
        </div>
        <div className="h-96 bg-slate-900 rounded-2xl"></div>
      </main>
    );
  }

  const kpis = data?.kpis;
  const incidentsPayload = data?.incidents;
  const incidents = incidentsPayload?.items || [];
  const notifications = data?.notifications;
  const planner = data?.plannerSummary;
  const health = data?.health;
  const timings = data?.diagnostics?.timings;

  const reasonsList = Array.from(new Set(incidents.map((i) => i.reasonName)));

  const filteredIncidents = incidents.filter((inc) => {
    if (filterReason !== "all" && inc.reasonName !== filterReason) return false;
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
    if (sortBy === "newest") return new Date(b.firstDetectedAt).getTime() - new Date(a.firstDetectedAt).getTime();
    return 0;
  });

  return (
    <main id="main-content" tabIndex={-1} className="min-h-dvh bg-slate-950 text-slate-100 p-6 max-w-7xl mx-auto space-y-8">
      {/* Header & Health Monitor */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-semibold uppercase tracking-wider mb-2">
            OpsPilot · Điều hành vận hành
          </div>
          <h1 className="text-3xl font-extrabold text-slate-100">Trung tâm điều hành vận hành</h1>
          <p className="text-sm text-slate-400">
            Ưu tiên sự cố, khuyến nghị AI, phê duyệt của con người và kết quả sau hành động.
          </p>
        </div>

        {/* Scope, Controls Governance & Health Indicators */}
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/reviews"
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 text-xs font-semibold text-amber-200 transition hover:bg-amber-500/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
          >
            Cần phê duyệt {copilotReviews.unavailable ? "—" : `(${copilotReviews.pending})`}
          </Link>
          <Link
            href="/decisions"
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-indigo-500/40 bg-indigo-500/10 px-4 text-xs font-semibold text-indigo-200 transition hover:bg-indigo-500/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-300"
          >
            Hộp quyết định
          </Link>
          <div className="grid w-full gap-2 rounded-xl border border-slate-800 bg-slate-900 p-3 text-xs sm:w-auto sm:grid-cols-3">
            <label className="grid gap-1 font-semibold text-slate-400">Vùng
            <select
              value={selectedZone}
              onChange={(event) => { setSelectedZone(event.target.value); setSelectedPic(""); setSelectedWarehouse(""); }}
              className="min-h-11 rounded border border-slate-700 bg-slate-950 px-3 font-semibold text-slate-200"
            >
              <option value="">Tất cả vùng được phép</option>
              {(accountScope?.zones || []).map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </select>
            </label>
            <label className="grid gap-1 font-semibold text-slate-400">PIC
              <select value={selectedPic} onChange={(event) => { setSelectedPic(event.target.value); setSelectedWarehouse(""); }} className="min-h-11 rounded border border-slate-700 bg-slate-950 px-3 font-semibold text-slate-200">
                <option value="">Tất cả PIC</option>
                {(accountScope?.pics || []).filter((pic) => visiblePicIds.has(pic.employeeId)).map((pic) => <option key={pic.employeeId} value={pic.employeeId}>{pic.name || `MSNV ${pic.employeeId}`}</option>)}
              </select>
            </label>
            <label className="grid gap-1 font-semibold text-slate-400">Kho
              <select value={selectedWarehouse} onChange={(event) => setSelectedWarehouse(event.target.value)} className="min-h-11 max-w-72 rounded border border-slate-700 bg-slate-950 px-3 font-semibold text-slate-200">
                <option value="">Tất cả kho phù hợp ({visibleWarehouses.length})</option>
                {(selectedZone || selectedPic ? visibleWarehouses : []).map((warehouse) => <option key={warehouse.warehouseId} value={warehouse.warehouseId}>{warehouse.warehouseName}</option>)}
              </select>
            </label>
          </div>

          <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl text-xs">
                <span className="text-slate-400 font-semibold">Tình trạng hệ thống:</span>
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
            🔄 Làm mới ({timings?.totalMs || 0}ms)
          </button>
          <button type="button" onClick={() => void handleFreshSync()} disabled={syncing || !session.can("MANAGE_SYSTEM")} title={!session.can("MANAGE_SYSTEM") ? "Chỉ ADMIN được đồng bộ thủ công" : "Đồng bộ và tái tạo bằng chứng từ snapshot Rillnet"} aria-describedby={syncing ? "sync-progress" : undefined} className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-xl bg-blue-600 px-4 text-xs font-semibold text-white transition hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300 disabled:cursor-not-allowed disabled:opacity-50"><span aria-hidden="true" className={syncing ? "animate-spin motion-reduce:animate-none" : ""}>↻</span>{syncing ? `Đang đồng bộ ${String(Math.floor(syncElapsedSeconds/60)).padStart(2,"0")}:${String(syncElapsedSeconds%60).padStart(2,"0")}` : "Đồng bộ dữ liệu mới"}</button>
          <button type="button" onClick={() => void handleShadowFollowupRun()} disabled={shadowRunning || !session.can("MANAGE_SYSTEM")} title={!session.can("MANAGE_SYSTEM") ? "Chỉ ADMIN được chạy LC-10 SHADOW" : "Chỉ thu evidence follow-up đến hạn; không tự verify outcome"} aria-describedby={shadowRunning ? "shadow-run-progress" : undefined} className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-xl border border-cyan-400/50 bg-cyan-500/10 px-4 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-500/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"><span aria-hidden="true" className={shadowRunning ? "animate-spin motion-reduce:animate-none" : ""}>↻</span>{shadowRunning ? "Đang chạy LC-10…" : "Chạy LC-10 SHADOW"}</button>
        </div>
      </header>

      {syncing && <div id="sync-progress" role="status" aria-live="polite" className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-4 text-sm text-blue-100"><div className="flex flex-wrap items-center justify-between gap-2"><strong>{syncPhaseLabels[syncPhase] || "Đang đồng bộ dữ liệu"}</strong><span className="font-mono text-blue-200">{String(Math.floor(syncElapsedSeconds/60)).padStart(2,"0")}:{String(syncElapsedSeconds%60).padStart(2,"0")}</span></div><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-800" aria-hidden="true"><div className="h-full w-1/3 animate-pulse rounded-full bg-blue-400 motion-reduce:animate-none" /></div><p className="mt-2 text-blue-200/80">Snapshot gần nhất vẫn đang được hiển thị; bạn có thể tiếp tục sử dụng các màn hình khác.</p></div>}{syncMessage && <div role="status" className={`rounded-xl border p-3 text-sm ${syncMessage.startsWith("Không thể") ? "border-rose-500/30 bg-rose-500/10 text-rose-200" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"}`}>{syncMessage}</div>}
      {shadowRunning && <div id="shadow-run-progress" role="status" aria-live="polite" aria-busy="true" className="rounded-xl border border-cyan-500/30 bg-cyan-500/10 p-3 text-sm text-cyan-100">Đang quét follow-up đến hạn và ghi evidence ở chế độ SHADOW. Decision, outcome và PnL sẽ không bị thay đổi.</div>}
      {shadowRunMessage && <div role={shadowRunMessage.startsWith("Không thể") || shadowRunMessage.startsWith("Chỉ ADMIN") ? "alert" : "status"} aria-live="polite" className={`rounded-xl border p-3 text-sm ${shadowRunMessage.startsWith("Không thể") || shadowRunMessage.startsWith("Chỉ ADMIN") ? "border-rose-500/30 bg-rose-500/10 text-rose-200" : "border-cyan-500/30 bg-cyan-500/10 text-cyan-100"}`}>{shadowRunMessage}</div>}
      {shadowRuns.length > 0 && <section className="rounded-xl border border-cyan-500/20 bg-slate-900/70 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-sm font-bold text-cyan-100">LC-10 SHADOW — lịch sử evidence</h2><p className="mt-1 text-xs text-slate-400">Các lượt chạy chỉ thu evidence; không phải outcome verdict.</p></div><Link href="/decisions" className="text-xs font-semibold text-cyan-200 hover:text-cyan-100">Mở Decision Inbox →</Link></div><ul className="mt-3 space-y-2">{shadowRuns.slice(0, 5).map((run) => <li key={run.eventId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs"><span className={run.observationState === "READY_TO_VERIFY" ? "font-semibold text-emerald-200" : "font-semibold text-amber-200"}>{run.observationState === "READY_TO_VERIFY" ? `Evidence ${run.observedAffectedOrders ?? "—"} đơn` : "Chờ evidence"}</span><span className="font-mono text-slate-400">{run.decisionId.slice(0, 8)}</span><span className="text-slate-400">{new Date(run.occurredAt).toLocaleString("vi-VN")}</span></li>)}</ul></section>}

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

      {data?.source === "degraded_fallback" && (
        <div role="alert" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
          <p className="font-bold">Nguồn dữ liệu vận hành đang không khả dụng</p>
          <p className="mt-1 text-amber-200/80">
            Các giá trị bên dưới là trạng thái fallback an toàn, không phải số liệu vận hành thời gian thực.
            Hãy kiểm tra kết nối persistence trước khi ra quyết định.
          </p>
        </div>
      )}

      {/* Decision-first attention queue */}
      <section aria-labelledby="attention-heading" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="attention-heading" className="text-lg font-bold text-slate-100">Cần chú ý ngay</h2>
            <p className="text-xs text-slate-400">Các hàng đợi thực tế cần operator kiểm tra và quyết định.</p>
          </div>
          <Link href="/incidents" className="text-sm font-semibold text-blue-300 hover:text-blue-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400">
            Xem toàn bộ incident →
          </Link>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Link href="/incidents" className="min-h-28 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">
            <span className="text-xs font-semibold uppercase tracking-wide text-rose-200">Rủi ro nghiêm trọng</span>
            <span className="mt-2 block font-mono text-3xl font-bold text-rose-300">{data?.source === "degraded_fallback" ? "—" : kpis?.criticalRiskIncidents || 0}</span>
          </Link>
          <Link href="/reviews" className="min-h-28 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300">
            <span className="text-xs font-semibold uppercase tracking-wide text-amber-200">Tổng hợp sự cố cần con người duyệt</span>
            <span className="mt-2 block font-mono text-3xl font-bold text-amber-300">{copilotReviews.unavailable ? "—" : copilotReviews.pending}</span>
            {!copilotReviews.unavailable && <span className="text-xs text-amber-100/70">trên {copilotReviews.total} kết quả có sẵn</span>}
          </Link>
          <Link href="/planner" className="min-h-28 rounded-xl border border-purple-500/30 bg-purple-500/10 p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-300">
            <span className="text-xs font-semibold uppercase tracking-wide text-purple-200">Đề xuất của AI cần con người duyệt</span>
            <span className="mt-2 block font-mono text-3xl font-bold text-purple-300">{data?.source === "degraded_fallback" ? "—" : kpis?.plannerDraftsWaitingReview || 0}</span>
          </Link>
          <Link href="/followups" className="min-h-28 rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-300">
            <span className="text-xs font-semibold uppercase tracking-wide text-indigo-200">Kết quả đang chờ theo dõi</span>
            <span className="mt-2 block font-mono text-3xl font-bold text-indigo-300">{data?.source === "degraded_fallback" ? "—" : kpis?.followupsWaiting || 0}</span>
          </Link>
        </div>
      </section>

      {data?.source !== "degraded_fallback" && <>
      {/* SECTION 1: EXECUTIVE KPI HEADER */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Chỉ số vận hành chính</h2>
          {!data?.writeControlsEnabled && (
            <span className="text-[11px] text-amber-400 font-mono bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
              🔒 Chế độ chỉ đọc (không cho phép ghi ở production)
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
          <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl space-y-1">
            <span className="text-slate-400 font-semibold">Sự cố đang hoạt động</span>
            <span className="text-2xl font-extrabold text-amber-400 block font-mono">{kpis?.activeIncidents || 0}</span>
          </div>

          <div className="p-4 bg-slate-900 border border-rose-500/30 rounded-2xl space-y-1">
            <span className="text-rose-400 font-semibold">Sự cố rủi ro nghiêm trọng</span>
            <span className="text-2xl font-extrabold text-rose-400 block font-mono">{kpis?.criticalRiskIncidents || 0}</span>
          </div>

          <div className="p-4 bg-slate-900 border border-amber-500/30 rounded-2xl space-y-1">
            <span className="text-amber-400 font-semibold">Sự cố ưu tiên cao</span>
            <span className="text-2xl font-extrabold text-amber-400 block font-mono">{kpis?.highPriorityIncidents || 0}</span>
          </div>

          <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl space-y-1">
            <span className="text-slate-400 font-semibold">Thời gian tồn trung bình</span>
            <span className="text-2xl font-extrabold text-slate-100 block font-mono">{kpis?.averageIncidentDurationHours || 0}h</span>
          </div>

          <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl space-y-1">
            <span className="text-slate-400 font-semibold">Thời gian tồn đơn lâu nhất TB</span>
            <span className="text-2xl font-extrabold text-slate-100 block font-mono">{kpis?.averageOldestOrderAgeHours || 0}h</span>
          </div>

          <div className="p-4 bg-slate-900 border border-emerald-500/30 rounded-2xl space-y-1">
            <span className="text-emerald-400 font-semibold">Đã xử lý hôm nay</span>
            <span className="text-2xl font-extrabold text-emerald-400 block font-mono">{kpis?.incidentsResolvedToday || 0}</span>
          </div>

          <div className="p-4 bg-slate-900 border border-purple-500/30 rounded-2xl space-y-1">
            <span className="text-purple-400 font-semibold">Tác vụ AI đang chạy</span>
            <span className="text-2xl font-extrabold text-purple-400 block font-mono">
              {kpis?.aiJobsRunning || 0} <span className="text-xs font-normal text-slate-500">({kpis?.aiJobsPending || 0} đang chờ)</span>
            </span>
          </div>

          <div className="p-4 bg-slate-900 border border-rose-500/30 rounded-2xl space-y-1">
            <span className="text-rose-400 font-semibold">Thông báo thất bại</span>
            <span className="text-2xl font-extrabold text-rose-400 block font-mono">{kpis?.notificationsFailed || 0}</span>
          </div>

          <div className="p-4 bg-slate-900 border border-indigo-500/30 rounded-2xl space-y-1">
            <span className="text-indigo-400 font-semibold">Kết quả đang chờ theo dõi</span>
            <span className="text-2xl font-extrabold text-indigo-400 block font-mono">{kpis?.followupsWaiting || 0}</span>
          </div>

          <div className="p-4 bg-slate-900 border border-amber-500/30 rounded-2xl space-y-1">
            <span className="text-amber-400 font-semibold">Đề xuất xử lý bản nháp</span>
            <span className="text-2xl font-extrabold text-amber-400 block font-mono">{kpis?.plannerDraftsWaitingReview || 0}</span>
          </div>
        </div>
      </section>

      {/* SECTION 2: LIVE INCIDENT BOARD */}
      <section className="bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-6 shadow-xl">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
              Sự cố đang hoạt động
              <span className="text-xs font-normal text-slate-400 font-mono">
                ({incidentsPayload?.displayedCount || 0}/{incidentsPayload?.totalCount || 0} mục)
              </span>
            </h2>
            <p className="text-xs text-slate-400">Danh sách các sự cố vận hành đang hoạt động (phạm vi: {selectedScope === "all" ? "toàn hệ thống" : selectedScope})</p>
            <p className="mt-1 text-[11px] leading-4 text-slate-500">Xu hướng so số đơn của snapshot mới nhất với snapshot liền trước được lưu trong lịch sử sự cố; không mặc định là so với hôm qua.</p>
          </div>

          {/* Search & Sort */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <input
              type="text"
                placeholder="Tìm kho, tín hiệu..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-slate-950 border border-slate-800 text-slate-200 px-3 py-1.5 rounded-xl focus:outline-none focus:border-blue-500"
            />

            <select
              value={filterReason}
              onChange={(e) => setFilterReason(e.target.value)}
              className="bg-slate-950 border border-slate-800 text-slate-200 px-3 py-1.5 rounded-xl"
            >
              <option value="all">Tất cả tín hiệu</option>
              {reasonsList.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>

            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="bg-slate-950 border border-slate-800 text-slate-200 px-3 py-1.5 rounded-xl font-semibold"
            >
              <option value="priority">Xếp theo mức ưu tiên</option>
              <option value="age">Xếp theo tuổi đơn lớn nhất</option>
              <option value="newest">Xếp theo sự cố mới nhất</option>
            </select>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 font-semibold uppercase tracking-wider">
                <th className="py-3 px-2">Kho Hàng</th>
                <th className="py-3 px-2">Tín hiệu quan sát được</th>
                <th className="py-3 px-2">Mức ưu tiên</th>
                <th className="py-3 px-2">Xu Hướng</th>
                <th className="py-3 px-2">Số đơn</th>
                <th className="py-3 px-2">Tuổi đơn lớn nhất</th>
                <th className="py-3 px-2">Theo dõi sau phát hiện</th>
                <th className="py-3 px-2">Khuyến nghị</th>
                <th className="py-3 px-2">Phân tích AI</th>
                <th className="py-3 px-2"><span className="sr-only">Mở hồ sơ</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {filteredIncidents.map((inc) => (
                <tr key={inc.incidentId} className="hover:bg-slate-800/30 transition">
                  <td className="py-3 px-2 font-bold text-slate-200">{inc.warehouseName}</td>
                  <td className="max-w-72 py-3 px-2"><span tabIndex={0} title={`${observableSignalEvidence(inc.reasonName, inc.affectedOrderCount, inc.maximumAgeHours)} Điều kiện phát hiện: ${incidentRuleExplanation(inc.reasonName)} Tín hiệu này chưa phải kết luận nguyên nhân gốc.`} className="inline-flex cursor-help items-center gap-1.5 rounded font-semibold text-amber-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300">{incidentSignalLabel(inc.reasonName)}<CircleHelp aria-hidden="true" size={14}/></span></td>
                  <td className="py-3 px-2">{(() => { const priority = priorityPresentation(inc.priorityScore); return <span tabIndex={0} title={`Điểm xếp hàng ${inc.priorityScore}: ${priorityEvidence(inc.reasonName, inc.affectedOrderCount, inc.maximumAgeHours)}. Đây là thứ tự kiểm tra, không phải xác suất xảy ra lỗi.`} className={`inline-flex cursor-help items-center gap-1.5 rounded border px-2 py-1 text-[10px] font-bold uppercase focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300 ${priority.tone}`}>{priority.label}<CircleHelp aria-hidden="true" size={13}/></span>; })()}</td>
                  <td className="py-3 px-2">
                    <span className={`inline-flex items-center gap-1.5 font-semibold ${inc.trend === "improving" ? "text-emerald-400" : inc.trend === "worsening" ? "text-rose-400" : "text-slate-400"}`}>
                      {inc.trend === "improving" ? <TrendingDown aria-hidden="true" size={16}/> : inc.trend === "worsening" ? <TrendingUp aria-hidden="true" size={16}/> : inc.trend === "stagnant" ? <Minus aria-hidden="true" size={16}/> : <CircleHelp aria-hidden="true" size={16}/>}
                      {inc.previousAffectedOrderCount !== null && inc.previousAffectedOrderCount !== undefined ? `${Math.abs(inc.affectedOrderCount - inc.previousAffectedOrderCount)} đơn` : "Chưa đủ dữ liệu"}
                    </span>
                    {inc.previousAffectedOrderCount !== null && inc.previousAffectedOrderCount !== undefined ? <span className="mt-1 block text-[10px] leading-4 text-slate-500">{inc.previousAffectedOrderCount} → {inc.affectedOrderCount} đơn<br/>{inc.previousSnapshotAt ? new Date(inc.previousSnapshotAt).toLocaleString("vi-VN") : "snapshot trước"} → {inc.latestSnapshotAt ? new Date(inc.latestSnapshotAt).toLocaleString("vi-VN") : "hiện tại"}</span> : <span className="mt-1 block max-w-28 text-[10px] leading-4 text-slate-500">Cần ít nhất 2 snapshot để so sánh</span>}
                  </td>
                  <td className="py-3 px-2 font-mono font-bold">{inc.affectedOrderCount > 0 ? `${inc.affectedOrderCount} đơn` : "Chưa có dữ liệu"}</td>
                  <td className="py-3 px-2 font-mono">{inc.maximumAgeHours !== null && inc.maximumAgeHours !== undefined ? `${inc.maximumAgeHours} giờ` : "Chưa có dữ liệu"}</td>
                  <td className="py-3 px-2 font-mono text-purple-400">{inc.followupState === "FIRST_PUSH_PENDING" ? "CHỜ NHẮC LẦN 1" : inc.followupState === "RESOLVED" ? "ĐÃ XỬ LÝ" : inc.followupState === "NEW" ? "MỚI" : inc.followupState}</td>
                  <td className="py-3 px-2 font-mono">
                    <span className={inc.plannerStatus === "APPROVED" ? "text-emerald-400" : inc.plannerStatus === "DRAFT" ? "text-amber-400" : "text-slate-400"}>
                      {inc.plannerStatus === "DRAFT" ? "BẢN NHÁP" : inc.plannerStatus === "APPROVED" ? "ĐÃ PHÊ DUYỆT" : inc.plannerStatus === "NONE" ? "CHƯA CÓ" : inc.plannerStatus}
                    </span>
                  </td>
                  <td className="py-3 px-2 font-mono">
                    <span className={inc.aiStatus === "COMPLETED" ? "text-emerald-400" : inc.aiStatus === "PROCESSING" || inc.aiStatus === "PENDING" ? "text-amber-400" : "text-slate-400"}>
                      {inc.aiStatus === "COMPLETED" ? "ĐÃ HOÀN TẤT" : inc.aiStatus === "PENDING" ? "ĐANG CHỜ" : inc.aiStatus === "PROCESSING" ? "ĐANG XỬ LÝ" : "CHƯA CÓ"}
                    </span>
                  </td>
                  <td className="py-3 px-2 text-right"><Link href={`/incidents/${encodeURIComponent(inc.incidentId)}`} aria-label={`Mở hồ sơ ${inc.incidentKey}`} className="inline-flex min-h-11 items-center rounded-lg px-3 font-semibold text-blue-300 hover:bg-blue-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400">Chi tiết →</Link></td>
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

      {/* SECTION 5 & 6: NOTIFICATION CENTER & PLANNER RECOMMENDATIONS */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* SECTION 5: NOTIFICATION CENTER */}
        <section className="bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-4 shadow-xl">
          <div className="flex flex-col gap-2 border-b border-slate-800 pb-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-base font-bold text-slate-100">
                <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-emerald-400"></span> Hàng đợi thông báo
              </h2>
              <p className="mt-1 text-xs leading-5 text-slate-400">Các thông báo hệ thống đang chờ gửi hoặc đã xử lý.</p>
            </div>
            <span className="shrink-0 text-xs text-slate-400">
              Hiển thị {notifications?.displayedCount || 0}/{notifications?.totalCount || 0}
            </span>
          </div>

          <div className="space-y-2 text-xs">
            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
              {notifications?.items.map((act) => (
                <div key={act.id} className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="font-bold text-slate-200">{notificationActionLabels[act.actionType] || repairOperationalText(act.actionType)}</span>
                      <span className="text-slate-400">qua {notificationProviderLabels[act.provider.toLowerCase()] || repairOperationalText(act.provider)}</span>
                      <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold ${act.status === "SENT" ? "bg-emerald-500/20 text-emerald-400" : act.status === "FAILED" ? "bg-rose-500/20 text-rose-400" : "bg-amber-500/20 text-amber-400"}`}>
                        {notificationStatusLabels[act.status] || translateStatus(act.status)}
                      </span>
                    </div>
                  </div>

                  {data?.writeControlsEnabled && (
                    <div className="flex items-center gap-1.5">
                      {act.status === "FAILED" && session.can("MANAGE_SYSTEM") && (
                        <button onClick={() => handleNotificationAction(act.id, "retry")} className="px-2 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded text-[10px] font-bold">
                          Thử lại
                        </button>
                      )}
                      {["PENDING", "PROCESSING"].includes(act.status) && session.can("MANAGE_SYSTEM") && (
                        <button onClick={() => handleNotificationAction(act.id, "cancel")} className="px-2 py-1 bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 rounded text-[10px] font-bold">
                          Hủy
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {!notifications?.items.length && <p className="rounded-xl border border-dashed border-slate-700 p-4 text-center text-slate-400">Không có thông báo nào trong hàng đợi.</p>}
            </div>
          </div>
        </section>

        {/* SECTION 6: PLANNER RECOMMENDATIONS */}
        <section className="bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-4 shadow-xl">
          <div className="flex flex-col gap-2 border-b border-slate-800 pb-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-base font-bold text-slate-100">
                <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-purple-400"></span> Đề xuất xử lý
              </h2>
              <p className="mt-1 text-xs leading-5 text-slate-400">Những việc hệ thống đề nghị người vận hành kiểm tra hoặc thực hiện; bản nháp phải được duyệt trước khi sử dụng.</p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs">
              <span className="text-amber-400">Bản nháp: {planner?.draftCount || 0}</span>
              <span className="text-emerald-400">Đã duyệt: {planner?.approvedCount || 0}</span>
            </div>
          </div>

          <div className="space-y-3 max-h-72 overflow-y-auto pr-1 text-xs">
            {planner?.recentRecommendations.items.map((rec, index) => (
              <div key={`${rec.runId}:${rec.id}:${index}`} className="p-3 bg-slate-950 border border-slate-800 rounded-xl space-y-2">
                <div className="flex flex-col gap-2 border-b border-slate-900 pb-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <span className="inline-flex rounded bg-purple-500/20 px-2 py-1 text-[10px] font-bold text-purple-300">
                      {plannerRecommendationLabels[rec.type] || repairOperationalText(rec.type)}
                    </span>
                    <p className="mt-2 break-words font-bold leading-5 text-slate-200">{repairOperationalText(rec.title)}</p>
                  </div>
                  <span className={`shrink-0 rounded px-2 py-1 text-[9px] font-bold ${rec.status === "APPROVED" ? "bg-emerald-500/20 text-emerald-400" : rec.status === "REJECTED" ? "bg-rose-500/20 text-rose-400" : "bg-amber-500/20 text-amber-400"}`}>
                    {translateStatus(rec.status)}
                  </span>
                </div>

                {rec.status === "DRAFT" && data?.writeControlsEnabled && (
                  <div className="flex items-center justify-end gap-2 pt-1 border-t border-slate-900">
                    {session.can("REVIEW_COPILOT") && <button onClick={() => handlePlannerReview(rec.runId, "REJECTED")} className="px-3 py-1 bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-[10px] font-bold rounded">
                      Từ chối
                    </button>}
                    {session.can("REVIEW_COPILOT") && <button onClick={() => handlePlannerReview(rec.runId, "APPROVED")} className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold rounded">
                      Phê duyệt
                    </button>}
                  </div>
                )}
              </div>
            ))}
            {!planner?.recentRecommendations.items.length && <p className="rounded-xl border border-dashed border-slate-700 p-4 text-center text-slate-400">Chưa có khuyến nghị vận hành.</p>}
          </div>
        </section>
      </div>

      </>}
    </main>
  );
}
