import type { IIncidentRepository } from "@/repositories/interfaces/IIncidentRepository";
import type { IIncidentHistoryRepository } from "@/repositories/interfaces/IIncidentHistoryRepository";
import type { IFollowupRepository } from "@/repositories/interfaces/IFollowupRepository";
import type { IPlannerRepository } from "@/repositories/interfaces/IPlannerRepository";
import type { IDecisionService } from "../interfaces/IDecisionService";
import type { IDecisionPilotService, CreateShadowFromIncidentInput } from "../interfaces/IDecisionPilotService";
import { DecisionDomainError } from "@/domain/decision";
import { makeFinalDecision } from "@/domain/final-decision";
import type { PlannerResult } from "@/agents/action-planner/schema";
import { critiqueFinalDecision } from "@/domain/decision-critic";

function riskFromScore(score: number): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  if (score >= 85) return "CRITICAL";
  if (score >= 65) return "HIGH";
  if (score >= 35) return "MEDIUM";
  return "LOW";
}

export class DecisionPilotService implements IDecisionPilotService {
  constructor(
    private readonly incidentRepo: IIncidentRepository,
    private readonly historyRepo: IIncidentHistoryRepository,
    private readonly followupRepo: IFollowupRepository,
    private readonly plannerRepo: IPlannerRepository,
    private readonly decisionService: IDecisionService
  ) {}

  async createShadowFromIncident(input: CreateShadowFromIncidentInput) {
    try {
      if (!input.incidentId?.trim()) throw new DecisionDomainError("VALIDATION_ERROR", "incidentId is required.");
      const incident = await this.incidentRepo.getIncidentById(input.incidentId);
      if (!incident) throw new DecisionDomainError("NOT_FOUND", `Incident '${input.incidentId}' not found.`);
      const existingDecisions = await this.decisionService.list(200);
      if (!existingDecisions.ok) throw new DecisionDomainError("DECISION_LOOKUP_FAILED", existingDecisions.message || "Unable to check existing decisions for this incident.");
      const listedDecisions = Array.isArray(existingDecisions.data)
        ? existingDecisions.data as Array<{ decisionId: string; decisionStatus: string; sourceLinks?: { incidentId?: string } }>
        : [];
      const existing = listedDecisions
        .find((decision) => decision?.sourceLinks?.incidentId === incident.id);
      if (existing) throw new DecisionDomainError("INCIDENT_ALREADY_HAS_DECISION", `Incident này đã có decision ${existing.decisionId} ở trạng thái ${existing.decisionStatus}; không tạo SHADOW trùng.`);

      const history = await this.historyRepo.getIncidentHistory(incident.id);
      // Follow-up records are keyed by incident_id, but older adapters also
      // expose incident_key lookup. Resolve both shapes without duplicating
      // follow-up domain logic here.
      const followupById = await this.followupRepo.getCaseById(incident.id);
      const followup = followupById || (await this.followupRepo.getCasesByIncidentKeys([incident.incident_key]))[0] || null;
      const planner = await this.plannerRepo.getLatestPlannerRunByIncidentId(incident.id);
      const plannerResult = (planner?.result || {}) as Partial<PlannerResult>;
      const latest = [...history].sort(
        (a, b) => new Date(b.recorded_at || 0).getTime() - new Date(a.recorded_at || 0).getTime()
      )[0];
      const finalDecision = makeFinalDecision({
        incidentId: incident.id,
        plannerRunId: planner?.id || "no-planner",
        plannerConfidence: Number(plannerResult.confidence?.score ?? incident.priority_score ?? 0),
        recommendations: Array.isArray(plannerResult.recommendations) ? plannerResult.recommendations : [],
        investigations: Array.isArray(plannerResult.investigations) ? plannerResult.investigations : [],
        limitations: Array.isArray(plannerResult.limitations) ? plannerResult.limitations : [],
      });
      const critic = critiqueFinalDecision({ finalDecision });
      const criticAbstained = critic.verdict === "HUMAN_INVESTIGATION_REQUIRED";
      const confidenceScore = Number(plannerResult.confidence?.score ?? incident.priority_score ?? 0);
      const boundedConfidence = Number.isFinite(confidenceScore) ? Math.min(Math.max(confidenceScore, 0), 100) : 0;
      const sourceFingerprint = [incident.id, incident.updated_at || incident.last_detected_at, planner?.id || "no-planner"].join(":");

      return await this.decisionService.create({
        sourceLinks: {
          sourceType: "INCIDENT_PILOT",
          sourceId: incident.id,
          incidentId: incident.id,
          followupCaseId: followup?.id || undefined,
          plannerRunId: planner?.id || undefined,
        },
        sourceFingerprint,
        idempotencyKey: input.idempotencyKey?.trim() || `shadow:${sourceFingerprint}`,
        problem: `${incident.reason_name} tại ${incident.warehouse_name || incident.warehouse_id}`,
        rootCause: String((plannerResult as Record<string, unknown>).rootCauseSummary || (plannerResult as Record<string, unknown>).rootCause || `Chưa đủ dữ liệu để xác định nguyên nhân gốc của ${incident.reason_name}.`),
        recommendedAction: criticAbstained
          ? critic.humanInvestigation?.action || "Human investigation is required before an operational decision can be made."
          : finalDecision.selectedOption?.action || "Human investigation is required before an operational decision can be made.",
        alternatives: criticAbstained ? [] : finalDecision.alternatives.slice(0, 3).map((item) => item.action),
        evidence: {
          sourceIdentifiers: { incidentId: incident.id, incidentKey: incident.incident_key, warehouseId: incident.warehouse_id },
          signalContext: { reasonCode: incident.reason_code, reasonName: incident.reason_name, status: incident.status },
          rootCauseContext: { plannerRunId: planner?.id || null, summary: (plannerResult as Record<string, unknown>).rootCauseSummary || (plannerResult as Record<string, unknown>).rootCause || null },
          actionContext: {
            plannerRunId: planner?.id || null,
            disposition: criticAbstained ? "HUMAN_INVESTIGATION_REQUIRED" : finalDecision.disposition,
            originalFinalDecisionDisposition: finalDecision.disposition,
            selectedOptionId: criticAbstained ? null : finalDecision.selectedOption?.optionId || null,
            selectionRationale: finalDecision.selectionRationale,
            expectedOperationalOutcome: finalDecision.expectedOperationalOutcome,
            risksAndLimitations: finalDecision.risksAndLimitations,
            evidenceRefs: finalDecision.evidenceRefs,
            humanInvestigation: critic.humanInvestigation || finalDecision.humanInvestigation,
            finalDecisionProvenance: finalDecision.provenance,
            decisionCritic: critic,
            manualApprovalRequired: true,
          },
          operationalFacts: {
            affectedOrderCount: latest?.affected_order_count ?? null,
            maximumAgeHours: latest?.maximum_age_hours ?? null,
            averageAgeHours: latest?.average_age_hours ?? null,
            oldestOrderCode: latest?.oldest_order_code ?? null,
            sampleOrderCodes: latest?.sample_order_codes ?? [],
            followupState: followup?.current_state ?? null,
            capturedFrom: "incident-pilot-adapter",
            capturedAt: new Date().toISOString(),
          },
        },
        confidence: boundedConfidence,
        riskLevel: riskFromScore(Number(incident.priority_score || 0)),
        mode: "SHADOW",
        decisionDeadline: input.decisionDeadline || null,
        actor: input.actor,
      });
    } catch (error) {
      if (error instanceof DecisionDomainError) return { ok: false, error: error.code, message: error.message };
      return { ok: false, error: "DECISION_PILOT_FAILED", message: error instanceof Error ? error.message : String(error) };
    }
  }
}
