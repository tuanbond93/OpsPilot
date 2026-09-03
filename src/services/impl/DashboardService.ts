import { IDashboardService, DashboardContext } from "../interfaces/IDashboardService";
import { BusinessRules } from "../../config/business-rules";
import { IDashboardRepository } from "../../repositories/interfaces/IDashboardRepository";
import { IAiJobRepository } from "../../repositories/interfaces/IAiJobRepository";
import { ISyncRunRepository } from "../../repositories/interfaces/ISyncRunRepository";
import { HealthRegistry } from "../../integrations/health";
import { StartupValidator } from "../../integrations/startup-validator";
import { ITriageAuditRepository } from "../../repositories/interfaces/ITriageAuditRepository";

const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;

export function getVietnamDayWindow(nowMs: number) {
  const vietnamNow = new Date(nowMs + VIETNAM_OFFSET_MS);
  const startMs = Date.UTC(vietnamNow.getUTCFullYear(), vietnamNow.getUTCMonth(), vietnamNow.getUTCDate()) - VIETNAM_OFFSET_MS;
  return { startMs, endMs: startMs + 24 * 60 * 60 * 1000, startIso: new Date(startMs).toISOString() };
}

export function isTimestampInWindow(value: unknown, startMs: number, endMs: number) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= startMs && timestamp < endMs;
}

export class DashboardService implements IDashboardService {
  constructor(
    private dashboardRepo: IDashboardRepository,
    private aiJobRepo: IAiJobRepository,
    private syncRepo: ISyncRunRepository,
    private triageAuditRepo: ITriageAuditRepository
  ) {}

  async getDashboard(context: DashboardContext): Promise<any> {
    const tStart = performance.now();
    const { nowMs: now, nowIso, scope: configuredScope, writeControlsEnabled, allowedWarehouseIds } = context;

    let incidentsMs = 0;
    let historiesMs = 0;
    let followupsMs = 0;
    let plannerMs = 0;
    let aiJobsMs = 0;
    let notificationsMs = 0;
    let syncRunMs = 0;

    const todayStr = nowIso.slice(0, 10);
    // Vietnam does not observe daylight saving time. Calculate a stable local
    // day window so "hôm nay" never silently means the current UTC date.
    const vietnamDay = getVietnamDayWindow(now);
    const isTodayInVietnam = (value: unknown) => isTimestampInWindow(value, vietnamDay.startMs, vietnamDay.endMs);
    const t0 = performance.now();

    const [
      incidentsListRaw,
      warehousesListRaw,
      plannerListRaw,
      notificationsListRaw,
      telegramRemindersToday,
      latestSyncRun,
      recentSyncRuns,
      allAiJobs,
      actionEvents,
      followupEvents,
      plannerReviewEvents,
    ] = await Promise.all([
      this.dashboardRepo.getIncidentSummaries(),
      this.dashboardRepo.getWarehouseSummaries(),
      this.dashboardRepo.getPlannerSummaries(),
      this.dashboardRepo.getNotificationSummaries(),
      this.dashboardRepo.getTelegramFollowupRemindersUpdatedSince(vietnamDay.startIso),
      this.syncRepo.getLatestSyncRun(),
      this.syncRepo.getLatestSyncRuns(20),
      this.aiJobRepo.getAllJobs(100),
      this.dashboardRepo.getRecentActionEvents(30),
      this.dashboardRepo.getRecentFollowupEvents(30),
      this.dashboardRepo.getRecentPlannerReviewEvents(30),
    ]);

    incidentsMs = Math.round(performance.now() - t0);




    let totalDurationMs = 0;
    let totalMaxAge = 0;
    let ageCount = 0;

    let filteredIncidents = incidentsListRaw;
    if (allowedWarehouseIds) {
      const allowed = new Set(allowedWarehouseIds);
      filteredIncidents = incidentsListRaw.filter((i: any) => allowed.has(i.warehouse_id));
    } else if (configuredScope !== "all") {
      filteredIncidents = incidentsListRaw.filter((i: any) => i.warehouse_id === configuredScope);
    }

    const latestAiJobByIncident = new Map<string, any>();
    for (const job of allAiJobs) {
      if (job.incident_id && !latestAiJobByIncident.has(job.incident_id)) {
        latestAiJobByIncident.set(job.incident_id, job);
      }
    }

    const latestTriages = await this.triageAuditRepo.getLatestByIncidentIds(
      filteredIncidents.map((incident: any) => incident.incident_id).filter(Boolean)
    );
    const latestTriageByIncident = new Map(latestTriages.map((triage) => [triage.incidentId, triage]));

    const liveIncidentsList = filteredIncidents.map((i: any) => {
      let riskMap: any = { score: 50, level: "medium" };
      if (i.risk) {
        try {
          // Parse risk, falling back to defaults if parsing fails
          const parsed = typeof i.risk === "object" ? i.risk : JSON.parse(i.risk);
          // Ensure score respects tier2 bounds
          const min = BusinessRules.ai.riskTiers.tier2.min;
          const max = BusinessRules.ai.riskTiers.tier2.max;
          riskMap = {
            ...parsed,
            score: Math.min(Math.max(parsed.score ?? 50, min), max),
            level: parsed.level ?? "medium",
          };
        } catch {
          riskMap = { score: 50, level: String(i.risk) };
        }
      }
      
      const triage = latestTriageByIncident.get(i.incident_id);
      const triageEvidence = triage?.evidence || {};
      const pilotScope = triageEvidence.pilotScope === true;
      return {
        incidentId: i.incident_id,
        incidentKey: i.incident_key || `INC-${i.incident_id.slice(0,8)}`,
        warehouseId: i.warehouse_id || "default",
        // Normalize historical fallback labels at the presentation boundary.
        warehouseName: i.warehouse_name === "Kho hng" ? "Kho hàng" : (i.warehouse_name || "Kho hàng"),
        reasonCode: i.reason_code || "UNKNOWN",
        reasonName: i.reason_name === "L?i v?n hnh" ? "Lỗi vận hành" : (i.reason_name || "Lỗi vận hành"),
        affectedOrderCount: Number(i.affected_order_count ?? 0),
        averageAgeHours: i.average_age_hours === null || i.average_age_hours === undefined ? null : Number(i.average_age_hours),
        maximumAgeHours: i.maximum_age_hours === null || i.maximum_age_hours === undefined ? null : Number(i.maximum_age_hours),
        oldestOrderCode: i.oldest_order_code || null,
        sampleOrderCodes: Array.isArray(i.sample_order_codes) ? i.sample_order_codes : [],
        // Priority is the deterministic incident score persisted by the incident engine.
        // Do not substitute the separate AI risk score here.
        priorityScore: Number(i.priority_score ?? riskMap.score ?? 0),
        risk: riskMap,
        trend: i.previous_affected_order_count === null || i.previous_affected_order_count === undefined
          ? "insufficient_data"
          : Number(i.affected_order_count) < Number(i.previous_affected_order_count)
          ? "improving"
          : Number(i.affected_order_count) > Number(i.previous_affected_order_count)
          ? "worsening"
          : "stagnant",
        previousAffectedOrderCount: i.previous_affected_order_count === null || i.previous_affected_order_count === undefined ? null : Number(i.previous_affected_order_count),
        latestSnapshotAt: i.latest_snapshot_at || null,
        previousSnapshotAt: i.previous_snapshot_at || null,
        followupState: i.followup_state || "NEW",
        followupResolvedAt: i.followup_resolved_at || null,
        followupClosedAt: i.followup_closed_at || null,
        plannerStatus: i.planner_status || "NONE",
        aiStatus: latestAiJobByIncident.get(i.incident_id)?.status || "NONE",
        triage: triage ? {
          route: triage.route,
          pilotScope,
          aiQueuePolicy: typeof triageEvidence.aiQueuePolicy === "string" ? triageEvidence.aiQueuePolicy : null,
          triageReason: triage.triageReason,
        } : null,
        firstDetectedAt: i.first_detected_at || nowIso,
        lastDetectedAt: i.last_detected_at || nowIso,
      };
    });

    const activeIncidentsCount = liveIncidentsList.length;
    const criticalRiskIncidents = liveIncidentsList.filter((i: any) => i.priorityScore >= BusinessRules.priority.critical).length;
    const highPriorityIncidents = liveIncidentsList.filter((i: any) => i.priorityScore >= BusinessRules.priority.high).length;

    for (const inc of liveIncidentsList) {
      if (inc.firstDetectedAt) {
        totalDurationMs += Math.max(0, now - new Date(inc.firstDetectedAt).getTime());
      }
      if (typeof inc.maximumAgeHours === "number" && inc.maximumAgeHours > 0) {
        totalMaxAge += inc.maximumAgeHours;
        ageCount++;
      }
    }

    const averageIncidentDurationHours = activeIncidentsCount > 0
      ? Math.round((totalDurationMs / (activeIncidentsCount * 3600000)) * 10) / 10
      : 0;

    const averageOldestOrderAgeHours = ageCount > 0
      ? Math.round((totalMaxAge / ageCount) * 10) / 10
      : 0;

    const incidentsResolvedToday = liveIncidentsList.filter((i: any) =>
      ["RESOLVED", "CLOSED"].includes(i.followupState)
      && (isTodayInVietnam(i.followupResolvedAt) || isTodayInVietnam(i.followupClosedAt))
    ).length;

    const telegramPushSentToday = telegramRemindersToday.filter((reminder: any) =>
      reminder.status === "SENT" && isTodayInVietnam(reminder.sent_at)
    ).length;
    const telegramPushFailedToday = telegramRemindersToday.filter((reminder: any) =>
      reminder.status === "FAILED" && isTodayInVietnam(reminder.updated_at)
    ).length;

    const aiJobsPending = allAiJobs.filter((j: any) => j.status === "PENDING").length;
    const aiJobsRunning = allAiJobs.filter((j: any) => j.status === "PROCESSING").length;

    let notificationsPending = 0;
    let notificationsFailed = 0;
    let notificationsSent = 0;
    let notificationsSimulated = 0;
    let notificationsCancelled = 0;

    for (const n of notificationsListRaw) {
      notificationsPending += n.pending || 0;
      notificationsFailed += n.failed || 0;
      notificationsSent += n.sent || 0;
      if (n.simulation) {
        notificationsSimulated++;
      }
    }

    const followupsWaiting = liveIncidentsList.filter((i: any) =>
      ["WAITING_FOR_RESPONSE", "NEXT_CHECK_PENDING", "FIRST_PUSH_PENDING", "SECOND_PUSH_PENDING", "THIRD_PUSH_PENDING", "ESCALATION_PENDING", "FOLLOWING_UP", "RILLNET_CHANGE_PAUSED"].includes(
        i.followupState
      )
    ).length;

    const plannerDraftsWaitingReview = plannerListRaw.filter((r: any) => r.approval_state === "DRAFT").length;

    const kpis = {
      activeIncidents: activeIncidentsCount,
      criticalRiskIncidents,
      highPriorityIncidents,
      averageIncidentDurationHours,
      averageOldestOrderAgeHours,
      incidentsResolvedToday,
      aiJobsPending,
      aiJobsRunning,
      notificationsPending,
      notificationsFailed: telegramPushFailedToday,
      telegramPushSentToday,
      followupsWaiting,
      plannerDraftsWaitingReview,
    };

    const boundedIncidents = {
      items: liveIncidentsList.slice(0, 20),
      totalCount: liveIncidentsList.length,
      displayedCount: Math.min(20, liveIncidentsList.length),
      hasMore: liveIncidentsList.length > 20,
    };

    const completedTodayAi = allAiJobs.filter((j: any) => j.status === "COMPLETED" && j.completed_at?.startsWith(todayStr)).length;
    const failedTodayAi = allAiJobs.filter((j: any) => j.status === "FAILED" && j.updated_at?.startsWith(todayStr)).length;
    const retryQueueCount = allAiJobs.filter((j: any) => j.status === "PENDING" && j.attempt_count > 0).length;

    let totalRuntimeMs = 0;
    let completedRuntimeCount = 0;

    for (const j of allAiJobs) {
      if (j.status === "COMPLETED" && j.started_at && j.completed_at) {
        totalRuntimeMs += new Date(j.completed_at).getTime() - new Date(j.started_at).getTime();
        completedRuntimeCount++;
      }
    }
    const averageRuntimeMs = completedRuntimeCount > 0 ? Math.round(totalRuntimeMs / completedRuntimeCount) : 1200;

    const workerStatus = {
      pendingCount: aiJobsPending,
      processingCount: aiJobsRunning,
      completedTodayCount: completedTodayAi,
      failedTodayCount: failedTodayAi,
      retryQueueCount,
      workerHealth: failedTodayAi > 5 ? "degraded" : aiJobsRunning > 0 ? "healthy" : "idle",
      lastExecution: allAiJobs[0]?.updated_at || null,
      averageRuntimeMs,
      queueDepth: aiJobsPending + aiJobsRunning,
    };

    const resolvedCasesCount = liveIncidentsList.filter((c: any) => c.followupState === "CLOSED" || c.followupState === "RESOLVED").length;
    const escalatedCasesCount = liveIncidentsList.filter((c: any) => ["ESCALATED", "ESCALATION_PENDING"].includes(c.followupState)).length;

    const boundedFollowups = {
      totalCases: liveIncidentsList.length,
      resolvedCases: resolvedCasesCount,
      escalatedCases: escalatedCasesCount,
      pendingConfirmationCount: liveIncidentsList.filter((c: any) => c.followupState === "WAITING_FOR_RESPONSE").length,
      items: liveIncidentsList.slice(0, 20).map((c: any) => ({
        incidentKey: c.incidentKey,
        currentState: c.followupState,
        nextActionAt: null,
        lastCheckedAt: c.lastDetectedAt,
        progressPercent: c.followupState === "CLOSED" ? 100 : 50,
        progressAssessment: "monitored_by_read_model",
      })),
      totalCount: liveIncidentsList.length,
      displayedCount: Math.min(20, liveIncidentsList.length),
      hasMore: liveIncidentsList.length > 20,
    };

    const boundedNotifications = {
      pending: notificationsPending,
      processing: 0,
      sent: notificationsSent,
      simulated: notificationsSimulated,
      failed: notificationsFailed,
      cancelled: notificationsCancelled,
      items: notificationsListRaw.slice(0, 20).map((n: any) => ({
        id: n.incident_id,
        actionType: "DISPATCH",
        provider: n.simulation ? "console" : "telegram",
        targetType: "INCIDENT",
        targetId: n.incident_id,
        status: n.failed > 0 ? "FAILED" : n.pending > 0 ? "PENDING" : "SENT",
        outcome: n.simulation ? "SIMULATED" : "SENT",
        retryCount: n.retry,
        lastError: null,
        createdAt: n.created_at,
      })),
      totalCount: notificationsListRaw.length,
      displayedCount: Math.min(20, notificationsListRaw.length),
      hasMore: notificationsListRaw.length > 20,
    };

    const approvedPlannerCount = plannerListRaw.filter((r: any) => r.approval_state === "APPROVED").length;
    const rejectedPlannerCount = plannerListRaw.filter((r: any) => r.approval_state === "REJECTED").length;

    const recentRecommendations: any[] = [];
    for (const r of plannerListRaw) {
      const rec = r.recommendation;
      if (rec && Array.isArray(rec.recommendations)) {
        for (const item of rec.recommendations) {
          recentRecommendations.push({
            id: item.id || `rec-${r.incident_id}`,
            runId: r.incident_id,
            incidentId: r.incident_id,
            title: item.title || item.type,
            type: item.type,
            targetRole: item.targetRole || "OPERATIONS_LEAD",
            priority: item.priority || "high",
            confidenceScore: r.confidence || 85,
            status: r.approval_state,
          });
        }
      }
    }

    const boundedPlannerSummary = {
      draftCount: plannerDraftsWaitingReview,
      approvedCount: approvedPlannerCount,
      rejectedCount: rejectedPlannerCount,
      recentRecommendations: {
        items: recentRecommendations.slice(0, 20),
        totalCount: recentRecommendations.length,
        displayedCount: Math.min(20, recentRecommendations.length),
        hasMore: recentRecommendations.length > 20,
      },
    };

    const rawTimelineItems: any[] = [];

    if (latestSyncRun) {
      const syncTime = latestSyncRun.completed_at || latestSyncRun.started_at;
      rawTimelineItems.push({
        eventId: `sync-${latestSyncRun.id}`,
        eventType: "SYNC_WORKFLOW_FINISHED",
        source: "sync_runs",
        occurredAt: syncTime,
        entityId: latestSyncRun.id,
        title: "Rillnet Snapshot Sync Completed",
        description: `Fetched ${latestSyncRun.fetched_order_count} orders, aggregated ${latestSyncRun.incident_count} incidents in ${latestSyncRun.duration_ms || 0}ms.`,
        actor: "system_cron",
      });
    }

    for (const fe of followupEvents || []) {
      rawTimelineItems.push({
        eventId: `fevt-${fe.id}`,
        eventType: `FOLLOWUP_${fe.event_type}`,
        source: "followup_events",
        occurredAt: fe.event_time || fe.created_at || nowIso,
        entityId: fe.followup_case_id,
        title: `Follow-up Transition: ${fe.old_state} ? ${fe.new_state}`,
        description: `Assessment: ${fe.assessment}. ${fe.notes || ""}`.trim(),
        actor: fe.confirmed_by || "system_engine",
      });
    }

    for (const ae of actionEvents || []) {
      rawTimelineItems.push({
        eventId: `actevt-${ae.id}`,
        eventType: `NOTIFICATION_${ae.event_type}`,
        source: "notification_action_events",
        occurredAt: ae.created_at || nowIso,
        entityId: ae.action_id,
        title: `Notification Action Event: ${ae.event_type}`,
        description: `Status changed from ${ae.old_status} to ${ae.new_status} via provider ${ae.provider}.`,
        actor: "notification_dispatcher",
      });
    }

    for (const pe of plannerReviewEvents || []) {
      rawTimelineItems.push({
        eventId: `pevt-${pe.id}`,
        eventType: `PLANNER_${pe.event_type}`,
        source: "planner_review_events",
        occurredAt: pe.created_at || nowIso,
        entityId: pe.planner_run_id,
        title: `Action Planner Review: ${pe.event_type}`,
        description: pe.note || `Run #${pe.planner_run_id} reviewed by operator.`,
        actor: pe.actor || "operator",
      });
    }

    rawTimelineItems.sort(
      (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
    );

    const boundedTimeline = {
      items: rawTimelineItems.slice(0, 30),
      totalCount: rawTimelineItems.length,
      displayedCount: Math.min(30, rawTimelineItems.length),
      hasMore: rawTimelineItems.length > 30,
    };

    if (HealthRegistry.getCheckers().length === 0) {
      await StartupValidator.run();
    }
    const healthReport = await HealthRegistry.checkAll();
    const comps = healthReport.components;

    const health = {
      database: comps.database || {
        status: "GREEN",
        healthReason: "Successfully query database",
        lastSuccessAt: nowIso,
        lastFailureAt: null,
        freshnessSeconds: 0,
      },
      aiWorker: comps.aiworker || comps.ai_worker || {
        status: "GREEN",
        healthReason: "AI background worker active",
        lastSuccessAt: nowIso,
        lastFailureAt: null,
        freshnessSeconds: 0,
      },
      notificationPlatform: comps.telegram || {
        status: "GREEN",
        healthReason: "Telegram notification dispatch online",
        lastSuccessAt: nowIso,
        lastFailureAt: null,
        freshnessSeconds: 0,
      },
      aiProvider: comps.aiprovider || {
        status: "GREEN",
        healthReason: "AI API services fully operational",
        lastSuccessAt: nowIso,
        lastFailureAt: null,
        freshnessSeconds: 0,
      },
      cronWorker: comps.scheduler || {
        status: "GREEN",
        healthReason: "declarative cron scheduler operational",
        lastSuccessAt: nowIso,
        lastFailureAt: null,
        freshnessSeconds: 0,
      },
      // A failed/latest attempt must not be presented as a fresh snapshot.
      lastSync: latestSyncRun?.completed_at || latestSyncRun?.started_at || null,
      lastSuccessfulSync: recentSyncRuns.find((run) => run.status === "success")?.completed_at || recentSyncRuns.find((run) => run.status === "success")?.started_at || null,
      latestSyncStatus: latestSyncRun?.status || null,
      lastAiWorker: allAiJobs[0]?.updated_at || null,
      lastNotificationDispatch: null,
    };

    const aggregationMs = Math.round(performance.now() - tStart);
    const totalMs = Math.round(performance.now() - tStart);

    return {
      ok: true,
      dataFreshness: "realtime",
      source: "database",
      scope: {
        configuredScope,
        appliedWarehouseFilter: allowedWarehouseIds ? `${allowedWarehouseIds.length} kho được phép` : configuredScope,
      },
      writeControlsEnabled,
      kpis,
      kpiDefinitions: {
        activeIncidents: "Incidents with status open or monitoring",
        criticalRiskIncidents: "Active incidents with priority_score >= 75 or critical risk level",
        highPriorityIncidents: "Active incidents with priority_score >= 50",
        averageIncidentDurationHours: "Average hours elapsed since first_detected_at for active incidents",
        averageOldestOrderAgeHours: "Average maximum_age_hours across active incidents from history snapshots",
        incidentsResolvedToday: "Follow-up cases moved to RESOLVED or CLOSED within the current Vietnam day",
        aiJobsPending: "Count of AI background analysis jobs in PENDING status",
        aiJobsRunning: "Count of AI background analysis jobs in PROCESSING status",
        notificationsPending: "Count of notification actions in PENDING status",
        notificationsFailed: "Telegram follow-up cases with a failed delivery in the current Vietnam day",
        telegramPushSentToday: "Telegram follow-up cases delivered successfully in the current Vietnam day",
        followupsWaiting: "Follow-up cases in active waiting states",
        plannerDraftsWaitingReview: "Action Planner runs in DRAFT status waiting for review",
      },
      incidents: boundedIncidents,
      workerStatus,
      followups: boundedFollowups,
      notifications: boundedNotifications,
      plannerSummary: boundedPlannerSummary,
      timeline: boundedTimeline,
      health,
      diagnostics: {
        tier2: { min: BusinessRules.ai.riskTiers.tier2.min, max: BusinessRules.ai.riskTiers.tier2.max, points: 10 },
        timings: {
          incidentsMs,
          historiesMs,
          followupsMs,
          plannerMs,
          aiJobsMs,
          notificationsMs,
          syncRunMs,
          aggregationMs,
          totalMs,
        },
      },
    };
  }
}
