import type { IIncidentService } from "../interfaces/IIncidentService";
import type { IIncidentRepository } from "@/repositories/interfaces/IIncidentRepository";
import type { IIncidentHistoryRepository } from "@/repositories/interfaces/IIncidentHistoryRepository";
import { RillnetConnector } from "@/connectors/rillnet";
import { aggregateIncidents } from "@/engine/incident";
import { RootCauseAgent } from "@/agents/root-cause";

export class IncidentService implements IIncidentService {
  constructor(
    private incidentRepo: IIncidentRepository | null = null,
    private historyRepo: IIncidentHistoryRepository | null = null,
    private rootCauseAgent: RootCauseAgent | null = null
  ) {}

  async listIncidents(): Promise<{ source: string; totalIncidents: number; incidents: any[] }> {
    if (this.incidentRepo) {
      try {
        const dbIncidents = await this.incidentRepo.getOpenIncidents();
        if (dbIncidents.length > 0) {
          const summaryFields = dbIncidents.map((inc) => ({
            incidentId: inc.id,
            incidentKey: inc.incident_key,
            warehouseId: inc.warehouse_id,
            warehouseName: inc.warehouse_name || "Kho chưa xác định",
            reasonCode: inc.reason_code,
            reasonName: inc.reason_name,
            affectedOrderCount: 0,
            priorityScore: inc.priority_score,
            firstDetectedAt: inc.first_detected_at,
            lastDetectedAt: inc.last_detected_at,
            averageAgeHours: null,
            maximumAgeHours: null,
            oldestOrderCode: null,
            sampleOrderCodes: [],
          }));

          return {
            source: "database",
            totalIncidents: summaryFields.length,
            incidents: summaryFields,
          };
        }
      } catch {
        // Fallback
      }
    }

    // Fallback to in-memory live calculation
    const connector = new RillnetConnector();
    const snapshotResult = await connector.fetchSnapshot();
    const incidents = aggregateIncidents(snapshotResult.orders);

    const summaryFields = incidents.map((inc) => ({
      incidentId: inc.incidentId,
      incidentKey: inc.incidentKey,
      warehouseId: inc.warehouseId,
      warehouseName: inc.warehouseName,
      reasonCode: inc.reasonCode,
      reasonName: inc.reasonName,
      affectedOrderCount: inc.affectedOrderCount,
      priorityScore: inc.priorityScore,
      firstDetectedAt: inc.firstDetectedAt,
      lastDetectedAt: inc.lastDetectedAt,
      averageAgeHours: inc.averageAgeHours,
      maximumAgeHours: inc.maximumAgeHours,
      oldestOrderCode: inc.oldestOrderCode,
      sampleOrderCodes: inc.sampleOrderCodes,
    }));

    return {
      source: "live_snapshot",
      totalIncidents: summaryFields.length,
      incidents: summaryFields,
    };
  }

  async getIncidentHistory(incidentId: string): Promise<{
    incident: any;
    history: any[];
    note?: string;
    message?: string;
  }> {
    if (this.incidentRepo && this.historyRepo) {
      try {
        const incidentRow = await this.incidentRepo.getIncidentById(incidentId);

        if (!incidentRow) {
          return {
            incident: {
              id: incidentId,
              incidentKey: incidentId,
              status: "not_found",
            },
            history: [],
          };
        }

        const historyRows = await this.historyRepo.getIncidentHistory(incidentRow.id);

        const history = historyRows.map((h: any) => ({
          recordedAt: h.recorded_at,
          affectedOrderCount: h.affected_order_count,
          averageAgeHours: h.average_age_hours ? Number(h.average_age_hours) : null,
          maximumAgeHours: h.maximum_age_hours ? Number(h.maximum_age_hours) : null,
          priorityScore: h.priority_score,
          sampleOrderCodes: h.sample_order_codes || [],
        }));

        return {
          incident: {
            id: incidentRow.id,
            incidentKey: incidentRow.incident_key,
            warehouseId: incidentRow.warehouse_id,
            warehouseName: incidentRow.warehouse_name,
            reasonCode: incidentRow.reason_code,
            reasonName: incidentRow.reason_name,
            status: incidentRow.status,
            priorityScore: incidentRow.priority_score,
            firstDetectedAt: incidentRow.first_detected_at,
            lastDetectedAt: incidentRow.last_detected_at,
            resolvedAt: incidentRow.resolved_at || null,
          },
          history,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          incident: { id: incidentId, incidentKey: incidentId },
          history: [],
          note: "Database table empty or not configured",
          message,
        };
      }
    }

    return {
      incident: { id: incidentId, incidentKey: incidentId },
      history: [],
      note: "Database table empty or not configured",
    };
  }

  async analyzeRootCause(incidentId: string): Promise<{
    ok: boolean;
    data?: any;
    error?: string;
    message?: string;
  }> {
    let targetIncident: any = null;
    let historyRows: any[] = [];

    // Strategy 1: Fetch from Supabase DB
    if (this.incidentRepo && this.historyRepo) {
      try {
        const dbInc = await this.incidentRepo.getIncidentById(incidentId);
        if (dbInc) {
          targetIncident = {
            incidentId: dbInc.id,
            incidentKey: dbInc.incident_key,
            warehouseId: dbInc.warehouse_id,
            warehouseName: dbInc.warehouse_name || "Kho chưa xác định",
            reasonCode: dbInc.reason_code,
            reasonName: dbInc.reason_name,
            status: dbInc.status,
            priorityScore: dbInc.priority_score,
            firstDetectedAt: dbInc.first_detected_at,
            lastDetectedAt: dbInc.last_detected_at,
            affectedOrderCount: 0,
            sampleOrderCodes: [],
            averageAgeHours: null,
            maximumAgeHours: null,
            oldestOrderCode: null,
          };

          historyRows = await this.historyRepo.getIncidentHistory(dbInc.id);
        }
      } catch {
        // Fallback
      }
    }

    // Strategy 2: In-memory live calculation fallback
    if (!targetIncident) {
      try {
        const connector = new RillnetConnector();
        const snapshotResult = await connector.fetchSnapshot();
        const incidents = aggregateIncidents(snapshotResult.orders);
        targetIncident = incidents.find(
          (inc) => inc.incidentId === incidentId || inc.incidentKey === incidentId
        );
      } catch {
        // Fallback
      }
    }

    if (!targetIncident) {
      return {
        ok: false,
        error: "NotFound",
        message: `Incident '${incidentId}' not found.`,
      };
    }

    try {
      const agent = this.rootCauseAgent || new RootCauseAgent();
      const result = await agent.analyzeIncident(targetIncident, historyRows);

      return {
        ok: true,
        data: {
          incident: {
            incidentId: targetIncident.incidentId,
            incidentKey: targetIncident.incidentKey,
            warehouseName: targetIncident.warehouseName,
            reasonCode: targetIncident.reasonCode,
            reasonName: targetIncident.reasonName,
            affectedOrderCount: targetIncident.affectedOrderCount,
          },
          context: {
            historyPointCount: result.context.historyPointCount,
            currentAffectedCount: result.context.currentAffectedCount,
            previousAffectedCount: result.context.previousAffectedCount,
            changeAbsolute: result.context.changeAbsolute,
            changePercent: result.context.changePercent,
            trendDirection: result.context.trendDirection,
            incidentDurationHours: result.context.incidentDurationHours,
          },
          evidence: result.evidence,
          analysis: result.analysis,
          metadata: result.metadata,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: "RootCauseAnalysisFailed",
        message,
      };
    }
  }

  async getOpenIncidents(): Promise<any[]> {
    if (!this.incidentRepo) return [];
    const dbIncidents = await this.incidentRepo.getOpenIncidents();
    return dbIncidents;
  }

  async resolveIncident(incidentId: string): Promise<void> {
    if (!this.incidentRepo) return;
    await this.incidentRepo.resolveAbsentIncidents([incidentId], "manual-resolution");
  }
}
