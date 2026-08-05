import type { Incident } from "../incident";
import type { IncidentHistoryRow, FollowupRepository, FollowupCaseRow } from "../../connectors/supabase";
import { evaluateProgressAssessment } from "./assessment";
import { evaluateNextState } from "./state-machine";
import { executeStateTransition } from "./transition";
import { FollowupMessageBuilder, type StructuredFollowupPayload } from "./message-builder";
import { DEFAULT_FOLLOWUP_CONFIG, type FollowupConfig } from "../../config/followup";
import { RootCauseAgent } from "../../agents/root-cause";

export interface ProcessedFollowupItem {
  incidentId: string;
  incidentKey: string;
  warehouseName: string;
  reasonName: string;
  oldState: string;
  newState: string;
  progressPercent: number;
  assessment: string;
  payload: StructuredFollowupPayload;
}

export class FollowupEngine {
  constructor(
    private followupRepo?: FollowupRepository | null,
    private rootCauseAgent?: RootCauseAgent | null
  ) {}

  /**
   * Processes all current operational incidents through the Follow-up State Machine.
   * Uses batched repository queries to prevent N+1 DB overhead.
   * State transitions and escalation decisions are 100% deterministic.
   * AI (RootCauseAgent) only provides text summary explanations.
   */
  async processIncidentFollowups(
    incidents: Incident[],
    historyMap: Map<string, IncidentHistoryRow[]> = new Map(),
    config: FollowupConfig = DEFAULT_FOLLOWUP_CONFIG,
    referenceTimeMs: number = Date.now()
  ): Promise<ProcessedFollowupItem[]> {
    const results: ProcessedFollowupItem[] = [];
    const rootAgent = this.rootCauseAgent || new RootCauseAgent();

    // 1. Batch fetch existing cases using incident_keys to eliminate N+1 queries
    const incidentKeys = incidents.map((inc) => inc.incidentKey || inc.incidentId);
    let existingCases: FollowupCaseRow[] = [];

    if (this.followupRepo) {
      try {
        if (incidentKeys.length > 0) {
          existingCases = await this.followupRepo.getCasesByIncidentKeys(incidentKeys);
        }
      } catch {
        // Fallback
      }
    }

    const caseMap = new Map<string, FollowupCaseRow>();
    for (const c of existingCases) {
      caseMap.set(c.incident_key, c);
    }

    const activeKeys = new Set(incidentKeys);

    // 2. Process active incidents
    for (const incident of incidents) {
      const incKey = incident.incidentKey || incident.incidentId;
      const historyRows = historyMap.get(incident.incidentId) || [];
      const existingCase = caseMap.get(incKey);

      const historyCount = historyRows.length + (existingCase ? 1 : 0);
      const baselineCount = existingCase
        ? existingCase.baseline_affected_order_count || incident.affectedOrderCount
        : incident.affectedOrderCount;

      const previousCount = existingCase
        ? existingCase.latest_affected_order_count || incident.affectedOrderCount
        : incident.affectedOrderCount;

      const { countChangePercent, progressPercent, assessment } = evaluateProgressAssessment(
        incident.affectedOrderCount,
        baselineCount,
        historyCount
      );

      const currentState = existingCase ? existingCase.current_state : "NEW";

      let timeSinceLastActionHours = 0;
      if (existingCase && (existingCase.last_action_requested_at || existingCase.last_checked_at)) {
        const lastTs = new Date(
          existingCase.last_action_requested_at || existingCase.last_checked_at
        ).getTime();
        timeSinceLastActionHours = Math.max(0, (referenceTimeMs - lastTs) / (1000 * 60 * 60));
      }

      let timeSinceResolvedHours = 0;
      if (existingCase && existingCase.resolved_at) {
        const resolvedTs = new Date(existingCase.resolved_at).getTime();
        timeSinceResolvedHours = Math.max(0, (referenceTimeMs - resolvedTs) / (1000 * 60 * 60));
      }

      const transitionResult = evaluateNextState(
        currentState,
        {
          incidentId: incident.incidentId,
          incidentKey: incKey,
          currentCount: incident.affectedOrderCount,
          baselineCount,
          previousCount,
          countChangePercent,
          progressPercent,
          progressAssessment: assessment,
          incidentDurationHours: incident.maximumAgeHours || 0,
          isIncidentActive: true,
          timeSinceLastActionHours,
          timeSinceResolvedHours,
        },
        config,
        referenceTimeMs
      );

      // AI provides explanation summary text ONLY
      let rootCauseSummary = "Theo dõi tồn đọng vận hành.";
      try {
        const agentAnalysis = await rootAgent.analyzeIncident(incident, historyRows);
        rootCauseSummary = agentAnalysis.analysis.summary;
      } catch {
        // Fallback
      }

      const payload = FollowupMessageBuilder.buildPayload({
        warehouse: incident.warehouseName,
        reason: incident.reasonName,
        currentCount: incident.affectedOrderCount,
        baselineCount,
        previousCount,
        progressPercent,
        progressAssessment: assessment,
        riskScore: incident.priorityScore,
        riskLevel: incident.priorityScore >= 75 ? "critical" : incident.priorityScore >= 50 ? "high" : "medium",
        rootCauseSummary,
        state: transitionResult.newState,
        nextActionAt: transitionResult.nextActionAt || (existingCase ? existingCase.next_action_at : null),
        lastActionRequestedAt: transitionResult.actionRequestedAt || (existingCase ? existingCase.last_action_requested_at : null),
        lastActionConfirmedAt: transitionResult.actionConfirmedAt || (existingCase ? existingCase.last_action_confirmed_at : null),
      });

      await executeStateTransition(
        {
          incidentId: incident.incidentId,
          incidentKey: incKey,
          firstDetectedAt: incident.firstDetectedAt,
          baselineCount,
          latestCount: incident.affectedOrderCount,
          changePercent: progressPercent,
          assessment,
          transitionResult,
          referenceTimeMs,
        },
        this.followupRepo
      );

      results.push({
        incidentId: incident.incidentId,
        incidentKey: incKey,
        warehouseName: incident.warehouseName,
        reasonName: incident.reasonName,
        oldState: transitionResult.oldState,
        newState: transitionResult.newState,
        progressPercent,
        assessment,
        payload,
      });
    }

    // 3. Process disappeared incidents (Resolve / Close)
    if (this.followupRepo) {
      try {
        const allCases = await this.followupRepo.getAllCases();
        for (const c of allCases) {
          if (!activeKeys.has(c.incident_key) && c.current_state !== "CLOSED") {
            let timeSinceResolvedHours = 0;
            if (c.resolved_at) {
              const resolvedTs = new Date(c.resolved_at).getTime();
              timeSinceResolvedHours = Math.max(0, (referenceTimeMs - resolvedTs) / (1000 * 60 * 60));
            }

            const transitionResult = evaluateNextState(
              c.current_state,
              {
                incidentId: c.incident_id,
                incidentKey: c.incident_key,
                currentCount: 0,
                baselineCount: c.baseline_affected_order_count,
                previousCount: c.latest_affected_order_count,
                countChangePercent: -100,
                progressPercent: 100,
                progressAssessment: "strong_progress",
                incidentDurationHours: 0,
                isIncidentActive: false,
                timeSinceLastActionHours: 0,
                timeSinceResolvedHours,
              },
              config,
              referenceTimeMs
            );

            await executeStateTransition(
              {
                incidentId: c.incident_id,
                incidentKey: c.incident_key,
                firstDetectedAt: c.first_detected_at,
                baselineCount: c.baseline_affected_order_count,
                latestCount: 0,
                changePercent: 100,
                assessment: "strong_progress",
                transitionResult,
                referenceTimeMs,
              },
              this.followupRepo
            );
          }
        }
      } catch {
        // Suppress errors during missing DB setup
      }
    }

    return results;
  }
}
