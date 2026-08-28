import type { ITriageAuditRepository, TriageAuditInsert, TriageAuditRecord } from "../interfaces/ITriageAuditRepository";

export class MockTriageAuditRepository implements ITriageAuditRepository {
  readonly records: TriageAuditInsert[] = [];

  async recordBatch(items: TriageAuditInsert[]): Promise<number> {
    const byKey = new Map(this.records.map((item) => [`${item.incidentId}:${item.syncRunId}`, item]));
    for (const item of items) byKey.set(`${item.incidentId}:${item.syncRunId}`, item);
    this.records.splice(0, this.records.length, ...byKey.values());
    return items.length;
  }

  async getLatestByIncidentIds(incidentIds: string[]): Promise<TriageAuditRecord[]> {
    const ids = new Set(incidentIds);
    return this.records
      .filter((item) => ids.has(item.incidentId))
      .map((item) => ({ ...item, createdAt: new Date(0).toISOString() }));
  }
}
