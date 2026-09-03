"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { Minus, TrendingDown, TrendingUp, CircleHelp, ChevronDown, RefreshCw, Settings2, ArrowRight, UserRound } from "lucide-react";
import { incidentRuleExplanation, incidentSignalLabel, repairOperationalText, statusGuidance, translateStatus } from "@/app/_components/operationalText";
import { handleApiAccess } from "@/app/_components/apiAccess";
import { useOpsSession } from "@/app/_components/useOpsSession";
import { OperatorStartHere } from "@/app/dashboard/OperatorStartHere";

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
  telegramPushSentToday: number;
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
  triage?: {
    route: string;
    pilotScope: boolean;
    aiQueuePolicy: string | null;
    triageReason: string;
  } | null;
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
  lastSuccessfulSync?: string | null;
  latestSyncStatus?: string | null;
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

function priorityPresentation(score: number) {
  if (score >= 75) return { label: "Rất cao", tone: "border-rose-500/40 bg-rose-500/10 text-rose-200" };
  if (score >= 50) return { label: "Cao", tone: "border-amber-500/40 bg-amber-500/10 text-amber-200" };
  return { label: "Theo dõi", tone: "border-sky-500/40 bg-sky-500/10 text-sky-200" };
}

function triagePresentation(incident: IncidentItem) {
  const triage = incident.triage;
  if (!triage) return null;
  if (triage.pilotScope && triage.route === "AUTO_HANDLE") {
    return {
      label: "Pilot MB3 · Theo rule",
      title: "Miền Bắc 3: theo dõi bằng rule xác định, không gọi AI. Con người vẫn thực hiện hành động vận hành.",
      tone: "border-cyan-500/40 bg-cyan-500/10 text-cyan-200",
    };
  }
  if (triage.pilotScope) {
    return {
      label: "Pilot MB3 · Cần AI/người",
      title: "Miền Bắc 3: case không đủ điều kiện tự xử lý, cần đánh giá tiếp.",
      tone: "border-violet-500/40 bg-violet-500/10 text-violet-200",
    };
  }
  if (triage.aiQueuePolicy === "OUT_OF_PILOT_LEGACY_QUEUE") {
    return {
      label: "Ngoài pilot · AI cũ",
      title: "Ngoài Miền Bắc 3: giữ nguyên luồng xếp hàng AI cũ.",
      tone: "border-slate-600 bg-slate-800/70 text-slate-300",
    };
  }
  return null;
}

const PRIORITY_REASON_WEIGHTS: Record<string, number> = {
  "Kho tồn": 1.5,
  "Kho chưa lấy": 1.3,
  "Thiếu shipper": 1.2,
  "Kho chưa luân chuyển": 1,
};

const VIETNAM_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;
const SCHEDULED_SYNC_HOURS_VIETNAM = [8, 10, 12, 14, 16, 18];

function formatVietnamDateTime(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Chưa có dữ liệu";
  return new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function syncScheduleCheck(lastSync: string | null, now = new Date()) {
  // Vietnam has no daylight-saving changes. Build the configured local cron
  // slots as UTC instants, then compare them with the persisted sync_runs time.
  const vietnamNow = new Date(now.getTime() + VIETNAM_UTC_OFFSET_MS);
  const slots: Date[] = [];
  for (const dayOffset of [-1, 0, 1]) {
    const localDay = new Date(Date.UTC(vietnamNow.getUTCFullYear(), vietnamNow.getUTCMonth(), vietnamNow.getUTCDate() + dayOffset));
    for (const hour of SCHEDULED_SYNC_HOURS_VIETNAM) slots.push(new Date(Date.UTC(localDay.getUTCFullYear(), localDay.getUTCMonth(), localDay.getUTCDate(), hour - 7)));
  }
  slots.sort((left, right) => left.getTime() - right.getTime());
  const previous = [...slots].reverse().find((slot) => slot.getTime() <= now.getTime()) || null;
  const next = slots.find((slot) => slot.getTime() > now.getTime()) || null;
  const onSchedule = Boolean(lastSync && previous && Date.parse(lastSync) >= previous.getTime());
  return { previous: previous?.toISOString() || null, next: next?.toISOString() || null, onSchedule };
}

const PREFERRED_OPERATION_ZONE = "Miền Bắc 3";

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

  const [syncing, setSyncing] = useState(false);
  const [dispatchingTelegramFollowups, setDispatchingTelegramFollowups] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncElapsedSeconds, setSyncElapsedSeconds] = useState(0);
  const [syncPhase, setSyncPhase] = useState("CREATED");
  const preferredZoneInitialized = useRef(false);

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

  const warehouseZoneById = useMemo(
    () => new Map((accountScope?.warehouses || []).map((warehouse) => [warehouse.warehouseId, warehouse.zone])),
    [accountScope]
  );

  useEffect(() => {
    fetch("/api/account/scope", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() : Promise.reject(new Error("Không thể tải phạm vi tài khoản")))
      .then((scope: AccountScope) => {
        setAccountScope(scope);
        if (!preferredZoneInitialized.current) {
          preferredZoneInitialized.current = true;
          try {
            const saved = JSON.parse(window.localStorage.getItem("opspilot-dashboard-scope") || "{}");
            const savedZone = typeof saved.zone === "string" && scope.zones.includes(saved.zone) ? saved.zone : "";
            const savedPic = typeof saved.pic === "string" && scope.pics.some((pic) => pic.employeeId === saved.pic) ? saved.pic : "";
            const savedWarehouse = typeof saved.warehouse === "string" && scope.warehouses.some((warehouse) => warehouse.warehouseId === saved.warehouse) ? saved.warehouse : "";
            setSelectedZone(savedZone || (scope.zones.includes(PREFERRED_OPERATION_ZONE) ? PREFERRED_OPERATION_ZONE : ""));
            setSelectedPic(savedPic);
            setSelectedWarehouse(savedWarehouse);
          } catch {
            if (scope.zones.includes(PREFERRED_OPERATION_ZONE)) setSelectedZone(PREFERRED_OPERATION_ZONE);
          }
        }
      })
      .catch(() => setAccountScope(null));
  }, []);

  useEffect(() => {
    if (!preferredZoneInitialized.current) return;
    window.localStorage.setItem("opspilot-dashboard-scope", JSON.stringify({ zone: selectedZone, pic: selectedPic, warehouse: selectedWarehouse }));
  }, [selectedPic, selectedWarehouse, selectedZone]);

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
        // The review queue already contains only incidents with a Copilot run.
        // Fetch it once instead of probing every dashboard incident and turning
        // the normal "analysis not created yet" state into a burst of 404s.
        const reviewResponse = await fetch("/api/copilot/reviews?limit=100", { cache: "no-store" });
        const reviewResult = await reviewResponse.json();
        handleApiAccess(reviewResponse, reviewResult, "Không thể tải hàng đợi đánh giá Copilot.");
        const visibleIncidentIds = new Set(
          (json.incidents?.items || []).map((incident: IncidentItem) => incident.incidentId)
        );
        const availableReviews = (reviewResult.items || [])
          .filter((item: { incidentId: string }) => visibleIncidentIds.has(item.incidentId))
          .map((item: { status?: string }) => item.status || "PENDING");
        setCopilotReviews({
          pending: availableReviews.filter((status: string) => status === "PENDING").length,
          total: availableReviews.length,
          unavailable: !reviewResult.ok,
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
    const interval = setInterval(fetchDashboardData, 30000);
    return () => clearInterval(interval);
  }, [fetchDashboardData]);

  useEffect(() => {
    if (!syncing) return;
    setSyncElapsedSeconds(0);
    const timer = setInterval(() => setSyncElapsedSeconds((seconds) => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [syncing]);

  async function handleFreshSync(rebuild = false) {
    if (!session.can("MANAGE_SYSTEM")) { setSyncMessage("Chỉ ADMIN được yêu cầu đồng bộ thủ công."); return; }
    setSyncMessage(null);
    setSyncPhase("FETCHING_SNAPSHOT");
    setSyncElapsedSeconds(0);
    setSyncing(true);
    try {
      const response = await fetch(`/api/debug/sync${rebuild ? "?mode=rebuild" : ""}`, { method: "POST" });
      const result = await response.json();
      if (response.status === 409) {
        setSyncMessage("Một phiên đồng bộ khác đang chạy. Hãy thử lại sau khi phiên đó hoàn tất.");
        return;
      }
      handleApiAccess(response, result, "Đồng bộ dữ liệu thất bại.");
      if (!result.ok) throw new Error(result.message || result.error?.message || "Đồng bộ dữ liệu thất bại");
      setSyncPhase("COMPLETED");
      const durationSeconds = Math.max(1, Math.round(result.durationMs / 1000));
      setSyncMessage(result.skipReason === "SOURCE_UNCHANGED"
        ? `Nguồn chưa thay đổi — kiểm tra hoàn tất trong ${durationSeconds} giây, giữ nguyên snapshot và bằng chứng hiện có.`
        : `Đã đồng bộ ${result.fetchedOrderCount} đơn, phát hiện ${result.incidentCount} sự cố trong ${durationSeconds} giây.`);
      await fetchDashboardData();
    } catch (syncError: unknown) {
      setSyncMessage(`Không thể đồng bộ: ${syncError instanceof Error ? syncError.message : String(syncError)}`);
    } finally {
      setSyncing(false);
    }
  }

  async function dispatchTelegramFollowupsNow() {
    if (!session.can("MANAGE_SYSTEM")) { setSyncMessage("Chỉ ADMIN được chạy nhắc việc Telegram pilot."); return; }
    setSyncMessage(null);
    setDispatchingTelegramFollowups(true);
    try {
      const response = await fetch("/api/cron/telegram-followup-pilot", { method: "POST" });
      const result = await response.json();
      handleApiAccess(response, result, "Không thể chạy nhắc việc Telegram pilot.");
      if (!result.ok) throw new Error(result.message || result.error || "Gửi Telegram pilot thất bại");
      const reasonCounts: Record<string, number> = {};
      if (Array.isArray(result.details)) {
        for (const item of result.details as Array<{ status?: string; reason?: string }>) {
          if (item.status === "SENT" || !item.reason) continue;
          reasonCounts[item.reason] = (reasonCounts[item.reason] || 0) + 1;
        }
      }
      const reasons = Object.entries(reasonCounts).map(([reason, count]) => `${reason} (${count})`);
      setSyncMessage(`Đã quét ${result.scanned || 0} case Miền Bắc 3: gửi ${result.sent || 0} tin cho ${result.coveredCases || 0} case, còn chờ lượt sau ${result.deferred || 0}, bỏ qua ${result.skipped || 0}, lỗi ${result.failed || 0}.${reasons.length ? ` Lý do: ${reasons.join("; ")}.` : ""}`);
      await fetchDashboardData();
    } catch (dispatchError: unknown) {
      setSyncMessage(`Không thể gửi Telegram pilot: ${dispatchError instanceof Error ? dispatchError.message : String(dispatchError)}`);
    } finally {
      setDispatchingTelegramFollowups(false);
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
  const health = data?.health;
  const syncSchedule = syncScheduleCheck(health?.lastSuccessfulSync || null);
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
    const aPreferred = warehouseZoneById.get(a.warehouseId) === PREFERRED_OPERATION_ZONE;
    const bPreferred = warehouseZoneById.get(b.warehouseId) === PREFERRED_OPERATION_ZONE;
    if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
    if (sortBy === "priority") return b.priorityScore - a.priorityScore;
    if (sortBy === "age") return b.maximumAgeHours - a.maximumAgeHours;
    if (sortBy === "newest") return new Date(b.firstDetectedAt).getTime() - new Date(a.firstDetectedAt).getTime();
    return 0;
  });

  const topIncident = filteredIncidents[0] || null;
  const roleName = ({ OPERATOR: "Người vận hành", REVIEWER: "Người duyệt", MANAGER: "Quản lý", ADMIN: "Quản trị viên" } as const)[session.role];
  const primaryTask = session.role === "REVIEWER" && copilotReviews.pending > 0
    ? { eyebrow: "Ưu tiên của người duyệt", title: `${copilotReviews.pending} bản tổng hợp đang chờ bạn`, detail: "Đối chiếu bằng chứng còn mới trước khi duyệt hoặc từ chối.", href: "/reviews", cta: "Mở hàng đợi cần duyệt", tone: "border-amber-500/40 from-amber-500/15" }
    : (session.role === "MANAGER" || session.role === "ADMIN") && (kpis?.plannerDraftsWaitingReview || 0) > 0
      ? { eyebrow: "Ưu tiên của quản lý", title: `${kpis?.plannerDraftsWaitingReview || 0} đề xuất cần quyết định`, detail: "Kiểm tra mức ảnh hưởng, bằng chứng và người chịu trách nhiệm trước khi phê duyệt.", href: "/planner", cta: "Mở đề xuất cần quyết định", tone: "border-violet-500/40 from-violet-500/15" }
      : topIncident
        ? { eyebrow: "Việc nên làm ngay", title: `${topIncident.warehouseName} · ${incidentSignalLabel(topIncident.reasonName)}`, detail: `${topIncident.affectedOrderCount} đơn ảnh hưởng · đơn lâu nhất ${topIncident.maximumAgeHours ?? "—"} giờ · mức ${priorityPresentation(topIncident.priorityScore).label.toLowerCase()}.`, href: `/incidents/${encodeURIComponent(topIncident.incidentId)}`, cta: "Mở sự cố và kiểm tra", tone: "border-rose-500/40 from-rose-500/15" }
        : { eyebrow: "Không có việc khẩn cấp", title: "Phạm vi hiện tại chưa có sự cố cần xử lý", detail: "Bạn có thể xem kết quả đang theo dõi hoặc đổi phạm vi kho.", href: "/followups", cta: "Xem kết quả đang theo dõi", tone: "border-emerald-500/40 from-emerald-500/15" };

  return (
    <main id="main-content" tabIndex={-1} className="min-h-dvh bg-slate-950 text-slate-100 p-6 max-w-7xl mx-auto space-y-8">
      {/* Header & Health Monitor */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-semibold uppercase tracking-wider mb-2">
            OpsPilot · Điều hành vận hành
          </div>
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-3xl font-extrabold text-slate-100">Trung tâm điều hành vận hành</h1><span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs font-semibold text-slate-300"><UserRound aria-hidden="true" size={14}/>{roleName}</span></div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">Đây là nơi bạn nhìn nhanh tình hình trong phạm vi phụ trách và bắt đầu xử lý việc quan trọng nhất.</p>
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

          <div className="flex min-h-11 items-center gap-2 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl text-xs">
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
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-800 bg-slate-900 px-4 text-xs font-semibold text-slate-200 transition hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-300"
          >
            <RefreshCw aria-hidden="true" size={16}/> Làm mới
          </button>
          {session.can("MANAGE_SYSTEM") && <details className="group w-full rounded-xl border border-slate-800 bg-slate-900 sm:w-auto">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 text-xs font-semibold text-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-300">
              <Settings2 aria-hidden="true" size={16}/><span>Công cụ quản trị dữ liệu</span><ChevronDown aria-hidden="true" size={15} className="ml-auto transition-transform group-open:rotate-180"/>
            </summary>
            <div className="grid gap-2 border-t border-slate-800 p-3 sm:min-w-72">
              <p className="text-xs leading-5 text-slate-400">Chỉ dùng khi cần cập nhật hoặc khôi phục dữ liệu hệ thống.</p>
              <button type="button" onClick={() => void handleFreshSync()} disabled={syncing} aria-describedby={syncing ? "sync-progress" : undefined} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"><RefreshCw aria-hidden="true" size={16} className={syncing ? "animate-spin motion-reduce:animate-none" : ""}/>{syncing ? `Đang đồng bộ ${String(Math.floor(syncElapsedSeconds/60)).padStart(2,"0")}:${String(syncElapsedSeconds%60).padStart(2,"0")}` : "Đồng bộ dữ liệu mới"}</button>
              <button type="button" onClick={() => void handleFreshSync(true)} disabled={syncing} className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-700 px-3 text-xs font-semibold text-slate-300 hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50">Tái tạo toàn bộ dữ liệu</button>
              <button type="button" onClick={() => void dispatchTelegramFollowupsNow()} disabled={dispatchingTelegramFollowups} className="inline-flex min-h-11 items-center justify-center rounded-xl border border-cyan-500/50 px-3 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-50">{dispatchingTelegramFollowups ? "Đang gửi Telegram…" : "Gửi nhắc việc Telegram"}</button>
            </div>
          </details>}
        </div>
      </header>

      <section aria-labelledby="sync-schedule-title" className={`rounded-xl border p-4 text-sm ${syncSchedule.onSchedule ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100" : "border-amber-500/40 bg-amber-500/10 text-amber-100"}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="sync-schedule-title" className="font-bold">Đồng bộ dữ liệu nguồn</h2>
            <p className="mt-1 text-xs leading-5 text-slate-300">Lịch cấu hình: 08:00, 10:00, 12:00, 14:00, 16:00 và 18:00 hằng ngày (giờ Việt Nam). Trạng thái được đối chiếu với lần chạy ghi trong <code>sync_runs</code>.</p>
          </div>
          <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${syncSchedule.onSchedule ? "border-emerald-400/40 text-emerald-200" : "border-amber-400/40 text-amber-200"}`}>{syncSchedule.onSchedule ? "Có snapshot mới từ mốc lịch gần nhất" : "Chưa có snapshot mới từ mốc lịch gần nhất"}</span>
        </div>
        <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
          <div className="rounded-lg bg-slate-950/50 p-2.5"><dt className="text-slate-400">Đồng bộ thành công gần nhất</dt><dd className="mt-1 font-semibold text-slate-100">{formatVietnamDateTime(health?.lastSuccessfulSync || null)}</dd><p className="mt-1 text-[11px] text-slate-400">Lần chạy gần nhất: {formatVietnamDateTime(health?.lastSync || null)} · {health?.latestSyncStatus || "chưa rõ"}</p></div>
          <div className="rounded-lg bg-slate-950/50 p-2.5"><dt className="text-slate-400">Mốc lịch vừa qua</dt><dd className="mt-1 font-semibold text-slate-100">{formatVietnamDateTime(syncSchedule.previous)}</dd></div>
          <div className="rounded-lg bg-slate-950/50 p-2.5"><dt className="text-slate-400">Mốc dự kiến kế tiếp</dt><dd className="mt-1 font-semibold text-slate-100">{formatVietnamDateTime(syncSchedule.next)}</dd></div>
        </dl>
      </section>

      {syncing && <div id="sync-progress" role="status" aria-live="polite" className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-4 text-sm text-blue-100"><div className="flex flex-wrap items-center justify-between gap-2"><strong>{syncPhaseLabels[syncPhase] || "Đang đồng bộ dữ liệu"}</strong><span className="font-mono text-blue-200">{String(Math.floor(syncElapsedSeconds/60)).padStart(2,"0")}:{String(syncElapsedSeconds%60).padStart(2,"0")}</span></div><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-800" aria-hidden="true"><div className="h-full w-1/3 animate-pulse rounded-full bg-blue-400 motion-reduce:animate-none" /></div><p className="mt-2 text-blue-200/80">Snapshot gần nhất vẫn đang được hiển thị; bạn có thể tiếp tục sử dụng các màn hình khác.</p></div>}{syncMessage && <div role="status" className={`rounded-xl border p-3 text-sm ${syncMessage.startsWith("Không thể") ? "border-rose-500/30 bg-rose-500/10 text-rose-200" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"}`}>{syncMessage}</div>}

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

      <OperatorStartHere
        incidents={data?.source === "degraded_fallback" ? 0 : (kpis?.activeIncidents || 0)}
        reviews={copilotReviews.unavailable ? 0 : copilotReviews.pending}
        followups={data?.source === "degraded_fallback" ? 0 : (kpis?.followupsWaiting || 0)}
      />

      <section aria-labelledby="primary-task-heading" className={`rounded-2xl border bg-gradient-to-br ${primaryTask.tone} to-slate-950 p-5 shadow-xl sm:p-6`}>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl"><p className="text-xs font-bold uppercase tracking-[.14em] text-cyan-200">{primaryTask.eyebrow}</p><h2 id="primary-task-heading" className="mt-2 text-xl font-bold text-white sm:text-2xl">{primaryTask.title}</h2><p className="mt-2 text-sm leading-6 text-slate-300">{primaryTask.detail}</p></div>
          <Link href={primaryTask.href} className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-xl bg-[#00a19a] px-5 text-sm font-bold text-black transition-colors hover:bg-[#17c8bf] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-200">{primaryTask.cta}<ArrowRight aria-hidden="true" size={18}/></Link>
        </div>
      </section>

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
            <span className="text-emerald-400 font-semibold">Case hoàn tất hôm nay</span>
            <span className="text-2xl font-extrabold text-emerald-400 block font-mono">{kpis?.incidentsResolvedToday || 0}</span>
          </div>

          <div className="p-4 bg-slate-900 border border-cyan-500/30 rounded-2xl space-y-1">
            <span className="text-cyan-400 font-semibold">Push case thành công hôm nay</span>
            <span className="text-2xl font-extrabold text-cyan-400 block font-mono">{kpis?.telegramPushSentToday || 0}</span>
          </div>

          <div className="p-4 bg-slate-900 border border-purple-500/30 rounded-2xl space-y-1">
            <span className="text-purple-400 font-semibold">Tác vụ AI đang chạy</span>
            <span className="text-2xl font-extrabold text-purple-400 block font-mono">
              {kpis?.aiJobsRunning || 0} <span className="text-xs font-normal text-slate-500">({kpis?.aiJobsPending || 0} đang chờ)</span>
            </span>
          </div>

          <div className="p-4 bg-slate-900 border border-rose-500/30 rounded-2xl space-y-1">
            <span className="text-rose-400 font-semibold">Push case thất bại hôm nay</span>
            <span className="text-2xl font-extrabold text-rose-400 block font-mono">{kpis?.notificationsFailed || 0}</span>
          </div>

          <div className="p-4 bg-slate-900 border border-indigo-500/30 rounded-2xl space-y-1">
            <span className="text-indigo-400 font-semibold">Kết quả đang chờ theo dõi</span>
            <span className="text-2xl font-extrabold text-indigo-400 block font-mono">{kpis?.followupsWaiting || 0}</span>
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
                  <td className="py-3 px-2 font-mono text-purple-400">
                    <span title={`${statusGuidance(inc.followupState).owner}: ${statusGuidance(inc.followupState).next}`}>{translateStatus(inc.followupState)}</span>
                    {(() => {
                      const triage = triagePresentation(inc);
                      return triage ? <span role="status" aria-atomic="true" title={triage.title} className={`mt-1 inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 font-sans text-[10px] font-bold ${triage.tone}`}>{triage.label}</span> : null;
                    })()}
                  </td>
                  <td className="py-3 px-2 font-mono">
                    <span className={inc.plannerStatus === "APPROVED" ? "text-emerald-400" : inc.plannerStatus === "DRAFT" ? "text-amber-400" : "text-slate-400"}>
                      {translateStatus(inc.plannerStatus)}
                    </span>
                  </td>
                  <td className="py-3 px-2 font-mono">
                    <span className={inc.aiStatus === "COMPLETED" ? "text-emerald-400" : inc.aiStatus === "PROCESSING" || inc.aiStatus === "PENDING" ? "text-amber-400" : "text-slate-400"}>
                      {translateStatus(inc.aiStatus || "NONE")}
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

      </>}
    </main>
  );
}
