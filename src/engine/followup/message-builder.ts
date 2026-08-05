import type { FollowupState, ProgressAssessment } from "./types";

export interface StructuredFollowupPayload {
  warehouse: string;
  reason: string;
  currentCount: number;
  baselineCount: number;
  previousCount: number;
  progressPercent: number;
  progressAssessment: ProgressAssessment;
  riskScore: number;
  riskLevel: string;
  rootCauseSummary: string;
  state: FollowupState;
  nextActionAt?: string | null;
  lastActionRequestedAt?: string | null;
  lastActionConfirmedAt?: string | null;
  escalationRequired: boolean;
}

export class FollowupMessageBuilder {
  /**
   * Constructs a structured payload for notifications, push alerts, or escalation reports
   */
  static buildPayload(params: {
    warehouse: string;
    reason: string;
    currentCount: number;
    baselineCount: number;
    previousCount: number;
    progressPercent: number;
    progressAssessment: ProgressAssessment;
    riskScore: number;
    riskLevel: string;
    rootCauseSummary?: string;
    state: FollowupState;
    nextActionAt?: string | null;
    lastActionRequestedAt?: string | null;
    lastActionConfirmedAt?: string | null;
  }): StructuredFollowupPayload {
    const escalationRequired = params.state === "ESCALATED" || params.state === "ESCALATION_PENDING";

    return {
      warehouse: params.warehouse || "Kho chưa xác định",
      reason: params.reason || "Sự cố vận hành",
      currentCount: params.currentCount,
      baselineCount: params.baselineCount,
      previousCount: params.previousCount,
      progressPercent: params.progressPercent,
      progressAssessment: params.progressAssessment,
      riskScore: params.riskScore,
      riskLevel: params.riskLevel,
      rootCauseSummary: params.rootCauseSummary || "Sự cố tồn đọng đang được hệ thống theo dõi.",
      state: params.state,
      nextActionAt: params.nextActionAt || null,
      lastActionRequestedAt: params.lastActionRequestedAt || null,
      lastActionConfirmedAt: params.lastActionConfirmedAt || null,
      escalationRequired,
    };
  }
}
