import type {
  IncidentRow,
  IncidentHistoryRow,
  OrderExceptionRow,
  FollowupCaseRow,
  FollowupEventRow,
} from "@/connectors/supabase";
import type { IPlannerRepository } from "@/repositories/interfaces/IPlannerRepository";
import type { NotificationActionRow } from "../../engine/action-queue";
import type { RootCauseResult } from "../root-cause/schema";
import { generate } from "../../ai/provider";
import { buildPlannerContext, type PlannerContext } from "./context-builder";
import { calculateConfidence } from "./confidence-calculator";
import { calculateNextReview } from "./next-review-calculator";
import { getBlockedOptions, getAllowedTargetRoles } from "./allowed-actions";
import type {
  PlannerResult,
  PlannerRecommendation,
  PlannerInvestigation,
  AllowedRecommendationType,
  AllowedTargetRole,
} from "./schema";

export interface ActionPlannerAgentOptions {
  provider?: string;
  model?: string;
  temperature?: number;
  forceRegenerate?: boolean;
  requestedBy?: string;
}

export interface PlannerAgentParams {
  incident: IncidentRow;
  historyRows?: IncidentHistoryRow[];
  rootCauseResult?: RootCauseResult | null;
  followupCase?: FollowupCaseRow | null;
  followupEvents?: FollowupEventRow[];
  actionHistory?: NotificationActionRow[];
  activeExceptions?: OrderExceptionRow[];
  options?: ActionPlannerAgentOptions;
  referenceTimeMs?: number;
}

export interface PlannerAgentResponse {
  result: PlannerResult;
  context: PlannerContext;
  cached: boolean;
  runId?: string;
}

export class ActionPlannerAgent {
  constructor(private repository?: IPlannerRepository | null) {}

  async analyzeIncident(params: PlannerAgentParams): Promise<PlannerAgentResponse> {
    const refTimeMs = params.referenceTimeMs || Date.now();
    const historyRows = params.historyRows || [];
    const followupEvents = params.followupEvents || [];
    const actionHistory = params.actionHistory || [];
    const activeExceptions = params.activeExceptions || [];
    const forceRegenerate = Boolean(params.options?.forceRegenerate);
    const requestedBy = params.options?.requestedBy ? String(params.options.requestedBy).trim() : null;

    if (forceRegenerate && !requestedBy) {
      throw new Error("requestedBy is required when forceRegenerate is true.");
    }

    // 1. Build Context
    const ctx = buildPlannerContext(
      params.incident,
      historyRows,
      params.rootCauseResult,
      params.followupCase,
      followupEvents,
      actionHistory,
      activeExceptions,
      refTimeMs,
      1
    );

    // 2. Cache Lifecycle & Force Regeneration Check
    if (this.repository) {
      const existingRun = await this.repository.getPlannerRunByContextHashAndVersion(
        params.incident.id,
        ctx.contextHash,
        ctx.promptVersion
      );

      if (existingRun && existingRun.result && typeof existingRun.result === "object") {
        if (!forceRegenerate) {
          // If status is DRAFT, APPROVED, or REJECTED, return cached run
          if (["DRAFT", "APPROVED", "REJECTED"].includes(existingRun.status)) {
            return {
              result: existingRun.result as unknown as PlannerResult,
              context: ctx,
              cached: true,
              runId: existingRun.id,
            };
          }
        } else {
          // Force regenerate requested: record immutable audit event
          await this.repository.insertReviewEvent({
            planner_run_id: existingRun.id,
            event_type: "REGENERATED",
            actor: requestedBy || "system",
            note: `Force regeneration requested for incident ${params.incident.incident_key}`,
          });
        }
      }
    }

    // 3. Compute Deterministic Components
    const deterministicNextReview = calculateNextReview(
      params.followupCase,
      ctx.metrics.riskLevel,
      ctx.metrics.trendAssessment,
      refTimeMs
    );

    const deterministicBlockedOptions = getBlockedOptions(ctx.missingData);

    // 4. Prepare Prompt Input Payload
    const promptInput = {
      incidentKey: params.incident.incident_key,
      warehouseName: params.incident.warehouse_name || params.incident.warehouse_id,
      reasonName: params.incident.reason_name,
      reasonCode: params.incident.reason_code,
      affectedCount: ctx.metrics.currentAffectedCount,
      trendAssessment: ctx.metrics.trendAssessment,
      riskLevel: ctx.metrics.riskLevel,
      riskScore: ctx.metrics.riskScore,
      durationHours: ctx.metrics.durationHours,
      allowedEvidenceCodes: ctx.allowedEvidenceCodes,
      allowedRecommendationTypes: ctx.allowedRecommendationTypes,
      allowedTargetRoles: ctx.allowedTargetRoles,
      evidenceList: ctx.evidenceList.map((e) => `[${e.code}] ${e.statement}`),
      followupState: params.followupCase ? params.followupCase.current_state : "Chưa có case theo dõi",
      rootCauseSummary: params.rootCauseResult ? params.rootCauseResult.summary : "Chưa có chẩn đoán nguyên nhân gốc",
    };

    let result: PlannerResult;
    let usedProvider = params.options?.provider || "ai_provider";
    let usedModel = params.options?.model || "default";

    // 5. Execute AI Generation with Strict Validation & Safe Fallback
    try {
      const aiRes = await generate("planner", promptInput, {
        provider: params.options?.provider,
        model: params.options?.model,
        temperature: params.options?.temperature || 0.2,
      });

      usedProvider = aiRes.model ? aiRes.model.split(":")[0] || usedProvider : usedProvider;
      usedModel = aiRes.model || usedModel;

      const parsed = this.parseAndValidateResult(
        aiRes.text,
        ctx,
        deterministicNextReview,
        deterministicBlockedOptions,
        usedProvider,
        usedModel,
        historyRows,
        params.rootCauseResult,
        params.followupCase,
        activeExceptions
      );

      if (parsed) {
        result = parsed;
      } else {
        // If ALL recommendations were invalid/rejected by strict governance, trigger safe fallback
        result = this.createFallbackResult(
          ctx,
          deterministicNextReview,
          deterministicBlockedOptions,
          "deterministic_fallback",
          "none",
          historyRows,
          params.rootCauseResult,
          params.followupCase,
          activeExceptions,
          ["Tất cả khuyến nghị từ AI không đáp ứng tiêu chuẩn quản trị an toàn và đã được thay thế bằng phương án dự phòng."]
        );
        usedProvider = "deterministic_fallback";
        usedModel = "none";
      }
    } catch {
      // Fallback on AI error
      result = this.createFallbackResult(
        ctx,
        deterministicNextReview,
        deterministicBlockedOptions,
        "deterministic_fallback",
        "none",
        historyRows,
        params.rootCauseResult,
        params.followupCase,
        activeExceptions
      );
      usedProvider = "deterministic_fallback";
      usedModel = "none";
    }

    // 6. Persist Draft Run if Repository is provided
    let runId: string | undefined;
    if (this.repository) {
      try {
        const createdRun = await this.repository.createPlannerRun({
          incident_id: params.incident.id,
          followup_case_id: params.followupCase?.id || null,
          status: "DRAFT",
          context_hash: ctx.contextHash,
          prompt_version: ctx.promptVersion,
          provider: usedProvider,
          model: usedModel,
          result: result as unknown as Record<string, unknown>,
        });

        runId = createdRun.id;

        await this.repository.insertReviewEvent({
          planner_run_id: createdRun.id,
          event_type: "CREATED",
          actor: "system",
          note: `Planner draft run created for incident ${params.incident.incident_key}`,
        });
      } catch {
        // Suppress repository error
      }
    }

    return {
      result,
      context: ctx,
      cached: false,
      runId,
    };
  }

  private parseAndValidateResult(
    rawText: string,
    ctx: PlannerContext,
    deterministicNextReview: PlannerResult["nextReview"],
    deterministicBlockedOptions: PlannerResult["blockedOptions"],
    provider: string,
    model: string,
    historyRows: IncidentHistoryRow[],
    rootCauseResult?: RootCauseResult | null,
    followupCase?: FollowupCaseRow | null,
    activeExceptions: OrderExceptionRow[] = []
  ): PlannerResult | null {
    let parsed: any = {};
    try {
      const cleaned = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return null;
    }

    const validationLimitations: string[] = [];
    const rawRecs = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
    const recommendations: PlannerRecommendation[] = [];

    for (let i = 0; i < rawRecs.length; i++) {
      const r = rawRecs[i];

      // 1. Strict Recommendation Type Validation (Reject invalid recommendation, do NOT convert)
      if (!ctx.allowedRecommendationTypes.includes(r.type)) {
        validationLimitations.push(
          `Khuyến nghị '${r.title || i + 1}' bị từ chối do loại hành động '${r.type}' không nằm trong danh sách cho phép.`
        );
        continue; // REJECT!
      }

      // 2. Strict Target Role Governance Validation (Reject invalid role, do NOT substitute)
      const allowedRolesForType = getAllowedTargetRoles(
        ctx.incident.reason_code,
        r.type,
        followupCase?.current_state,
        ctx.metrics.riskLevel
      );

      if (!allowedRolesForType.includes(r.targetRole)) {
        validationLimitations.push(
          `Khuyến nghị '${r.title || i + 1}' bị từ chối do vai trò '${r.targetRole}' không được phép cho loại hành động '${r.type}'.`
        );
        continue; // REJECT!
      }

      const validEvidenceCodes = Array.isArray(r.evidenceCodes)
        ? r.evidenceCodes.filter((code: string) => ctx.allowedEvidenceCodes.includes(code))
        : [];

      recommendations.push({
        id: `rec-${i + 1}`,
        type: r.type,
        title: String(r.title || "Khuyến nghị vận hành").trim(),
        description: String(r.description || "Thực hiện rà soát theo quy trình.").trim(),
        priority: ["high", "medium", "low"].includes(r.priority) ? r.priority : "medium",
        targetRole: r.targetRole,
        rationale: String(r.rationale || "Dựa trên dữ liệu bằng chứng sự cố.").trim(),
        evidenceCodes:
          validEvidenceCodes.length > 0
            ? validEvidenceCodes
            : [ctx.allowedEvidenceCodes[0] || "CURRENT_AFFECTED_COUNT"],
        riskImpact: {
          severity: ["low", "medium", "high", "critical"].includes(r.riskImpact?.severity)
            ? r.riskImpact.severity
            : ctx.metrics.riskLevel,
          potentialConsequence: String(
            r.riskImpact?.potentialConsequence || "Nguy cơ đọng đơn nếu không xử lý."
          ).trim(),
        },
        prerequisiteData: Array.isArray(r.prerequisiteData) ? r.prerequisiteData.map(String) : [],
        manualApprovalRequired: true, // ALWAYS true!
      });
    }

    // If ALL recommendations were rejected by strict governance, return null to trigger safe fallback
    if (recommendations.length === 0) {
      return null;
    }

    // Calculate refined confidence considering relevant missing data for valid recommendations
    const deterministicConfidence = calculateConfidence(
      historyRows,
      rootCauseResult,
      followupCase,
      activeExceptions,
      ctx.missingData,
      recommendations
    );

    // Sanitize investigations
    const rawInvs = Array.isArray(parsed.investigations) ? parsed.investigations : [];
    const investigations: PlannerInvestigation[] = [];

    for (let i = 0; i < rawInvs.length; i++) {
      const inv = rawInvs[i];
      investigations.push({
        id: `inv-${i + 1}`,
        priority: ["high", "medium", "low"].includes(inv.priority) ? inv.priority : "medium",
        action: String(inv.action || "Rà soát dữ liệu tồn kho").trim(),
        rationale: String(inv.rationale || "Xác minh các điểm nghẽn bằng chứng").trim(),
        targetDepartment: [
          "WAREHOUSE_OPS",
          "TRANSPORT_LOGISTICS",
          "CUSTOMER_SERVICE",
          "IT_SYSTEMS",
        ].includes(inv.targetDepartment)
          ? inv.targetDepartment
          : "WAREHOUSE_OPS",
        requiredData: Array.isArray(inv.requiredData) ? inv.requiredData.map(String) : ["Báo cáo ca trực"],
        safetyCheck: String(inv.safetyCheck || "Yêu cầu xác nhận của Trưởng ca trước khi thay đổi.").trim(),
      });
    }

    const limitations = [
      ...ctx.missingData.map((m) => `Hệ thống chưa kết nối nhóm dữ liệu: ${m}`),
      ...validationLimitations,
    ];

    return {
      executiveSummary: String(
        parsed.executiveSummary ||
          parsed.summary ||
          `Sự cố ${ctx.incident.reason_name} tại ${ctx.incident.warehouse_name || ctx.incident.warehouse_id} hiện có ${ctx.metrics.currentAffectedCount} đơn ảnh hưởng.`
      ).trim(),
      overallPriority: ctx.metrics.riskLevel === "critical" || ctx.metrics.riskLevel === "high" ? "high" : "medium",
      recommendations,
      investigations,
      blockedOptions: deterministicBlockedOptions,
      nextReview: deterministicNextReview,
      confidence: deterministicConfidence,
      limitations,
      metadata: {
        provider,
        model,
        promptVersion: ctx.promptVersion,
        generatedAt: new Date().toISOString(),
      },
    };
  }

  private createFallbackResult(
    ctx: PlannerContext,
    nextReview: PlannerResult["nextReview"],
    blockedOptions: PlannerResult["blockedOptions"],
    provider: string,
    model: string,
    historyRows: IncidentHistoryRow[],
    rootCauseResult?: RootCauseResult | null,
    followupCase?: FollowupCaseRow | null,
    activeExceptions: OrderExceptionRow[] = [],
    extraLimitations: string[] = []
  ): PlannerResult {
    const fallbackType: AllowedRecommendationType = ctx.allowedRecommendationTypes.includes(
      "PREPARE_ESCALATION"
    )
      ? "PREPARE_ESCALATION"
      : "CONTINUE_MONITORING";

    const fallbackRole: AllowedTargetRole = ctx.allowedTargetRoles[0] || "WAREHOUSE_DISPATCHER";

    const fallbackRec: PlannerRecommendation = {
      id: "rec-fallback-1",
      type: fallbackType,
      title:
        fallbackType === "PREPARE_ESCALATION"
          ? "Chuẩn bị hồ sơ leo thang sự cố"
          : "Theo dõi sát diễn biến tồn kho",
      description: "Ghi nhận chỉ số tồn đọng và sẵn sàng thông báo Trưởng ca kho nếu số đơn không giảm.",
      priority: ctx.metrics.riskLevel === "critical" ? "high" : "medium",
      targetRole: fallbackRole,
      rationale: "Dựa trên đánh giá rủi ro xác định và xu hướng biến động đơn đọng.",
      evidenceCodes: ctx.allowedEvidenceCodes.slice(0, 2),
      riskImpact: {
        severity: ctx.metrics.riskLevel,
        potentialConsequence: "Đơn hàng có nguy cơ trễ hạn cam kết SLA nếu không có biện pháp hỗ trợ.",
      },
      prerequisiteData: ["Báo cáo ca trực kho"],
      manualApprovalRequired: true,
    };

    const confidence = calculateConfidence(
      historyRows,
      rootCauseResult,
      followupCase,
      activeExceptions,
      ctx.missingData,
      [fallbackRec]
    );

    return {
      executiveSummary: `Sự cố ${ctx.incident.reason_name} tại ${
        ctx.incident.warehouse_name || ctx.incident.warehouse_id
      } ghi nhận ${ctx.metrics.currentAffectedCount} đơn hàng bị ảnh hưởng. Hệ thống khuyến nghị tiếp tục theo dõi tiến độ.`,
      overallPriority: ctx.metrics.riskLevel === "critical" || ctx.metrics.riskLevel === "high" ? "high" : "medium",
      recommendations: [fallbackRec],
      investigations: [
        {
          id: "inv-fallback-1",
          priority: "medium",
          action: "Kiểm tra danh sách đơn tồn lâu nhất (>48 giờ)",
          rationale: "Xác định các đơn hàng có nguy cơ vi phạm SLA cao nhất để xử lý trước.",
          targetDepartment: "WAREHOUSE_OPS",
          requiredData: ["Danh sách mã đơn hàng"],
          safetyCheck: "Kiểm tra trạng thái thực tế của đơn trên kệ kho trước khi cập nhật hệ thống.",
        },
      ],
      blockedOptions,
      nextReview,
      confidence,
      limitations: [
        ...ctx.missingData.map((m) => `Hệ thống chưa kết nối nhóm dữ liệu: ${m}`),
        ...extraLimitations,
      ],
      metadata: {
        provider,
        model,
        promptVersion: ctx.promptVersion,
        generatedAt: new Date().toISOString(),
      },
    };
  }
}
