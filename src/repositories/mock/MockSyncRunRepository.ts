import type { SyncRunRow, SyncPhase } from "@/connectors/supabase/types";
import type { ISyncRunRepository } from "../interfaces/ISyncRunRepository";

export class MockSyncRunRepository implements ISyncRunRepository {
  private inMemoryRuns: SyncRunRow[] = [];

  clearMemory(): void {
    this.inMemoryRuns = [];
  }

  seed(runs: SyncRunRow[]): void {
    this.inMemoryRuns = [...runs];
  }

  async createSyncRun(startedAt: string = new Date().toISOString()): Promise<SyncRunRow> {
    const fullRow: SyncRunRow = {
      id: `sync-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      started_at: startedAt,
      completed_at: null,
      status: "running",
      current_phase: "CREATED",
      completed_phases: ["CREATED"],
      fetched_order_count: 0,
      normalized_order_count: 0,
      incident_count: 0,
      duration_ms: null,
      error_code: null,
      error_message: null,
      source_updated_at: null,
      created_at: startedAt,
    };
    this.inMemoryRuns.push(fullRow);
    return fullRow;
  }

  async updatePhase(
    id: string,
    currentPhase: SyncPhase,
    completedPhases: SyncPhase[]
  ): Promise<SyncRunRow> {
    const item = this.inMemoryRuns.find((r) => r.id === id);
    if (item) {
      item.current_phase = currentPhase;
      item.completed_phases = [...completedPhases];
      return item;
    }

    const fallbackRow: SyncRunRow = {
      id,
      started_at: new Date().toISOString(),
      completed_at: null,
      status: "running",
      current_phase: currentPhase,
      completed_phases: [...completedPhases],
      fetched_order_count: 0,
      normalized_order_count: 0,
      incident_count: 0,
      duration_ms: null,
      error_code: null,
      error_message: null,
      source_updated_at: null,
      created_at: new Date().toISOString(),
    };
    this.inMemoryRuns.push(fallbackRow);
    return fallbackRow;
  }

  async updateSuccess(
    id: string,
    params: {
      completedAt: string;
      fetchedOrderCount: number;
      normalizedOrderCount: number;
      incidentCount: number;
      durationMs: number;
      sourceUpdatedAt?: string | null;
    }
  ): Promise<SyncRunRow> {
    const item = this.inMemoryRuns.find((r) => r.id === id);
    if (item) {
      item.completed_at = params.completedAt;
      item.status = "success";
      item.current_phase = "COMPLETED";
      item.fetched_order_count = params.fetchedOrderCount;
      item.normalized_order_count = params.normalizedOrderCount;
      item.incident_count = params.incidentCount;
      item.duration_ms = params.durationMs;
      item.source_updated_at = params.sourceUpdatedAt || null;
      return item;
    }

    const fallbackRow: SyncRunRow = {
      id,
      started_at: new Date().toISOString(),
      completed_at: params.completedAt,
      status: "success",
      current_phase: "COMPLETED",
      completed_phases: ["COMPLETED"],
      fetched_order_count: params.fetchedOrderCount,
      normalized_order_count: params.normalizedOrderCount,
      incident_count: params.incidentCount,
      duration_ms: params.durationMs,
      error_code: null,
      error_message: null,
      source_updated_at: params.sourceUpdatedAt || null,
      created_at: params.completedAt,
    };
    this.inMemoryRuns.push(fallbackRow);
    return fallbackRow;
  }

  async updateFailed(
    id: string,
    params: {
      completedAt: string;
      durationMs: number;
      errorCode: string;
      errorMessage: string;
    }
  ): Promise<SyncRunRow> {
    const item = this.inMemoryRuns.find((r) => r.id === id);
    if (item) {
      item.completed_at = params.completedAt;
      item.status = "failed";
      item.current_phase = "FAILED";
      item.duration_ms = params.durationMs;
      item.error_code = params.errorCode;
      item.error_message = params.errorMessage;
      return item;
    }

    const fallbackRow: SyncRunRow = {
      id,
      started_at: new Date().toISOString(),
      completed_at: params.completedAt,
      status: "failed",
      current_phase: "FAILED",
      completed_phases: ["FAILED"],
      fetched_order_count: 0,
      normalized_order_count: 0,
      incident_count: 0,
      duration_ms: params.durationMs,
      error_code: params.errorCode,
      error_message: params.errorMessage,
      source_updated_at: null,
      created_at: params.completedAt,
    };
    this.inMemoryRuns.push(fallbackRow);
    return fallbackRow;
  }

  async getUnfinishedSyncRun(): Promise<SyncRunRow | null> {
    const sorted = [...this.inMemoryRuns].sort(
      (a, b) => new Date(b.started_at || 0).getTime() - new Date(a.started_at || 0).getTime()
    );
    return sorted.find((r) => r.current_phase !== "COMPLETED" && r.status !== "success") || null;
  }

  async getLatestSyncRun(): Promise<SyncRunRow | null> {
    const sorted = [...this.inMemoryRuns].sort(
      (a, b) => new Date(b.started_at || 0).getTime() - new Date(a.started_at || 0).getTime()
    );
    return sorted[0] || null;
  }

  async getLatestSyncRuns(limit: number = 10): Promise<SyncRunRow[]> {
    return [...this.inMemoryRuns]
      .sort((a, b) => new Date(b.started_at || 0).getTime() - new Date(a.started_at || 0).getTime())
      .slice(0, limit);
  }

  async getPreviousSuccessfulSyncRun(currentSyncRunId: string): Promise<SyncRunRow | null> {
    const matches = this.inMemoryRuns
      .filter((r) => r.status === "success" && r.id !== currentSyncRunId)
      .sort((a, b) => new Date(b.started_at || 0).getTime() - new Date(a.started_at || 0).getTime());
    return matches[0] || null;
  }
}
