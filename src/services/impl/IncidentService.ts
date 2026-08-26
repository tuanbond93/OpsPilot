import type { IIncidentService } from "../interfaces/IIncidentService";
import type { IIncidentRepository } from "@/repositories/interfaces/IIncidentRepository";
import type { IIncidentHistoryRepository } from "@/repositories/interfaces/IIncidentHistoryRepository";
import { RillnetConnector } from "@/connectors/rillnet";
import { aggregateIncidents } from "@/engine/incident";
import { RootCauseAgent } from "@/agents/root-cause";
import type { IOrderSnapshotRepository } from "@/repositories/interfaces/IOrderSnapshotRepository";

export class IncidentService implements IIncidentService {
  constructor(
    private incidentRepo: IIncidentRepository | null = null,
    private historyRepo: IIncidentHistoryRepository | null = null,
    private rootCauseAgent: RootCauseAgent | null = null,
    private orderSnapshotRepo: IOrderSnapshotRepository | null = null
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
          oldestOrderCode: h.oldest_order_code || null,
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
          const latestHistory = [...historyRows].sort(
            (a: any, b: any) => new Date(b.recorded_at || 0).getTime() - new Date(a.recorded_at || 0).getTime()
          )[0];
          if (latestHistory) {
            targetIncident.affectedOrderCount = latestHistory.affected_order_count ?? 0;
            targetIncident.sampleOrderCodes = latestHistory.sample_order_codes || [];
            targetIncident.averageAgeHours = latestHistory.average_age_hours === null ? null : Number(latestHistory.average_age_hours);
            targetIncident.maximumAgeHours = latestHistory.maximum_age_hours === null ? null : Number(latestHistory.maximum_age_hours);
            targetIncident.oldestOrderCode = latestHistory.oldest_order_code || null;
            targetIncident.pickupJourneyCoveragePercent = Number(latestHistory.pickup_journey_coverage_percent ?? 0);
            targetIncident.pickupDelayedOrderCount = Number(latestHistory.pickup_delayed_order_count ?? 0);
            targetIncident.maximumPickupWaitHours = latestHistory.maximum_pickup_wait_hours === null || latestHistory.maximum_pickup_wait_hours === undefined
              ? null
              : Number(latestHistory.maximum_pickup_wait_hours);
            targetIncident.pickupDelayOrderCodes = latestHistory.pickup_delay_order_codes || [];

            if (this.orderSnapshotRepo?.getJourneyEvidenceForIncident) {
              const journeyRows = await this.orderSnapshotRepo.getJourneyEvidenceForIncident(
                latestHistory.sync_run_id,
                dbInc.warehouse_id,
                dbInc.reason_code
              );
              const journeys = journeyRows.flatMap((row) => {
                if (!row.order_created_at || !row.end_pick_at) return [];
                const createdAt = Date.parse(row.order_created_at);
                const endPickAt = Date.parse(row.end_pick_at);
                if (!Number.isFinite(createdAt) || !Number.isFinite(endPickAt) || endPickAt < createdAt) return [];
                return [{ orderCode: row.order_code, hours: Math.round(((endPickAt - createdAt) / 3_600_000) * 10) / 10 }];
              });
              const delayed = journeys.filter((item) => item.hours > 24).sort((a, b) => b.hours - a.hours);
              targetIncident.pickupJourneyCoveragePercent = journeyRows.length > 0
                ? Math.round((journeys.length / journeyRows.length) * 1000) / 10
                : 0;
              targetIncident.pickupDelayedOrderCount = delayed.length;
              targetIncident.maximumPickupWaitHours = delayed[0]?.hours ?? null;
              targetIncident.pickupDelayOrderCodes = delayed.slice(0, 5).map((item) => item.orderCode);
              latestHistory.pickup_journey_coverage_percent = targetIncident.pickupJourneyCoveragePercent;
              latestHistory.pickup_delayed_order_count = targetIncident.pickupDelayedOrderCount;
              latestHistory.maximum_pickup_wait_hours = targetIncident.maximumPickupWaitHours;
              latestHistory.pickup_delay_order_codes = targetIncident.pickupDelayOrderCodes;
            }

            // If persistence was not backfilled, use the same normalized live
            // Rillnet snapshot as a read-only evidence fallback.
            if (Number(targetIncident.pickupJourneyCoveragePercent || 0) === 0) {
              try {
                const liveSnapshot = await new RillnetConnector().fetchSnapshot();
                const liveIncident = aggregateIncidents(liveSnapshot.orders).find(
                  (item) => item.incidentKey === targetIncident.incidentKey
                );
                if (liveIncident && Number(liveIncident.pickupJourneyCoveragePercent || 0) > 0) {
                  targetIncident.pickupJourneyCoveragePercent = liveIncident.pickupJourneyCoveragePercent;
                  targetIncident.pickupDelayedOrderCount = liveIncident.pickupDelayedOrderCount;
                  targetIncident.maximumPickupWaitHours = liveIncident.maximumPickupWaitHours;
                  targetIncident.pickupDelayOrderCodes = liveIncident.pickupDelayOrderCodes;
                  targetIncident.journeyEvidenceSource = "live_rillnet";
                  latestHistory.pickup_journey_coverage_percent = liveIncident.pickupJourneyCoveragePercent;
                  latestHistory.pickup_delayed_order_count = liveIncident.pickupDelayedOrderCount;
                  latestHistory.maximum_pickup_wait_hours = liveIncident.maximumPickupWaitHours;
                  latestHistory.pickup_delay_order_codes = liveIncident.pickupDelayOrderCodes;
                }
              } catch {
                targetIncident.journeyEvidenceSource = "persisted_snapshot_unavailable";
              }
            } else {
              targetIncident.journeyEvidenceSource = "persisted_order_snapshots";
            }
          }
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

    // Enrich the verified pickup-delay statement with customer and pickup-warehouse
    // breakdowns from the current Rillnet snapshot. These fields are descriptive
    // evidence only and do not alter incident classification or risk scoring.
    if (targetIncident) {
      try {
        const liveSnapshot = await new RillnetConnector().fetchSnapshot();
        const liveIncident = aggregateIncidents(liveSnapshot.orders).find((item) => item.incidentKey === targetIncident.incidentKey);
        const affectedCodes = new Set(liveIncident?.affectedOrders || []);
        const delayedOrders = liveSnapshot.orders.filter((order) => {
          if (!affectedCodes.has(order.orderCode) || !order.createdAt || !order.endPickAt) return false;
          const created = Date.parse(order.createdAt);
          const picked = Date.parse(order.endPickAt);
          return Number.isFinite(created) && Number.isFinite(picked) && picked >= created && (picked - created) / 3_600_000 > 24;
        });
        const customerCounts = new Map<string, number>();
        const warehouseCounts = new Map<string, number>();
        for (const order of delayedOrders) {
          const customer = order.customerName || order.customerCode || "Khách hàng chưa xác định";
          customerCounts.set(customer, (customerCounts.get(customer) || 0) + 1);
          const warehouseId = String(order.pickWarehouseId || "unknown");
          warehouseCounts.set(warehouseId, (warehouseCounts.get(warehouseId) || 0) + 1);
        }
        let metadata: Record<string, { n?: string; name?: string }> = {};
        try {
          const response = await fetch(process.env.RILLNET_META_ENDPOINT || "https://rillnet-app.vercel.app/wh_meta.json");
          if (response.ok) metadata = await response.json();
        } catch { /* IDs remain explicit when metadata is unavailable */ }
        targetIncident.pickupDelayedCustomerBreakdown = [...customerCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
        targetIncident.pickupDelayedWarehouseBreakdown = [...warehouseCounts.entries()].map(([id, count]) => ({ id, name: metadata[id]?.n || metadata[id]?.name || `Kho ${id}`, count })).sort((a, b) => b.count - a.count);
      } catch {
        targetIncident.pickupDelayedCustomerBreakdown = [];
        targetIncident.pickupDelayedWarehouseBreakdown = [];
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
            pickupJourneyCoveragePercent: result.context.pickupJourneyCoveragePercent,
            pickupDelayedOrderCount: result.context.pickupDelayedOrderCount,
            maximumPickupWaitHours: result.context.maximumPickupWaitHours,
            pickupDelayOrderCodes: result.context.pickupDelayOrderCodes,
            pickupDelayedCustomerBreakdown: result.context.pickupDelayedCustomerBreakdown,
            pickupDelayedWarehouseBreakdown: result.context.pickupDelayedWarehouseBreakdown,
            journeyEvidenceSource: targetIncident.journeyEvidenceSource || "incident_history",
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
