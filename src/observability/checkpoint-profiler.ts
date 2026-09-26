/**
 * Checkpoint Pipeline V2 - High-Resolution Execution Profiler
 *
 * Captures fine-grained wall-clock durations and workload dimensions for
 * each phase of checkpoint execution. Used for performance auditing,
 * bottleneck diagnosis, and adaptive batch budget calculation.
 */

export interface CheckpointPhaseTimings {
  fetch_ms: number;
  population_build_ms: number;
  population_persist_ms: number;
  snapshot_persist_ms: number;
  incident_build_ms: number;
  incident_persist_ms: number;
  history_persist_ms: number;
  followup_seed_ms: number;
  cohort_hydration_ms: number;
  generation_persist_ms: number;
  transition_evaluation_ms: number;
  dispatch_ms: number;
  telegram_ms: number;
  total_invocation_ms: number;
}

export interface CheckpointWorkloadDimensions {
  order_count: number;
  observation_count: number;
  snapshot_count: number;
  incident_count: number;
  followup_case_count: number;
  followup_member_count: number;
  generation_count: number;
  dispatch_count: number;
}

export interface CheckpointRateMetrics {
  ms_per_1000_orders: number;
  ms_per_1000_incidents: number;
  ms_per_followup_case: number;
  ms_per_1000_members: number;
}

export interface CheckpointExecutionProfile {
  checkpoint_at: string;
  sync_run_id: string;
  timings: CheckpointPhaseTimings;
  workload: CheckpointWorkloadDimensions;
  rates: CheckpointRateMetrics;
  completed_at: string;
}

export class CheckpointProfiler {
  private timings: CheckpointPhaseTimings = {
    fetch_ms: 0,
    population_build_ms: 0,
    population_persist_ms: 0,
    snapshot_persist_ms: 0,
    incident_build_ms: 0,
    incident_persist_ms: 0,
    history_persist_ms: 0,
    followup_seed_ms: 0,
    cohort_hydration_ms: 0,
    generation_persist_ms: 0,
    transition_evaluation_ms: 0,
    dispatch_ms: 0,
    telegram_ms: 0,
    total_invocation_ms: 0,
  };

  private workload: CheckpointWorkloadDimensions = {
    order_count: 0,
    observation_count: 0,
    snapshot_count: 0,
    incident_count: 0,
    followup_case_count: 0,
    followup_member_count: 0,
    generation_count: 0,
    dispatch_count: 0,
  };

  private activeTimers = new Map<keyof CheckpointPhaseTimings, number>();
  private readonly startedAt: number;

  constructor(
    public readonly checkpointAt: string,
    public readonly syncRunId: string,
    startTime: number = performance.now()
  ) {
    this.startedAt = startTime;
  }

  startPhase(phase: keyof CheckpointPhaseTimings): void {
    this.activeTimers.set(phase, performance.now());
  }

  endPhase(phase: keyof CheckpointPhaseTimings): number {
    const start = this.activeTimers.get(phase);
    if (start === undefined) return 0;
    const elapsed = Math.round((performance.now() - start) * 100) / 100;
    this.timings[phase] = Math.round((this.timings[phase] + elapsed) * 100) / 100;
    this.activeTimers.delete(phase);
    return elapsed;
  }

  recordPhase(phase: keyof CheckpointPhaseTimings, durationMs: number): void {
    this.timings[phase] = Math.round((this.timings[phase] + durationMs) * 100) / 100;
  }

  setWorkload(counts: Partial<CheckpointWorkloadDimensions>): void {
    Object.assign(this.workload, counts);
  }

  incrementWorkload(counts: Partial<CheckpointWorkloadDimensions>): void {
    for (const [key, value] of Object.entries(counts)) {
      if (typeof value === "number") {
        const k = key as keyof CheckpointWorkloadDimensions;
        this.workload[k] = (this.workload[k] || 0) + value;
      }
    }
  }

  calculateRates(): CheckpointRateMetrics {
    const { order_count, incident_count, followup_case_count, followup_member_count } = this.workload;
    const ingestionTotal = this.timings.fetch_ms + this.timings.population_build_ms + this.timings.population_persist_ms + this.timings.snapshot_persist_ms;
    const incidentTotal = this.timings.incident_build_ms + this.timings.incident_persist_ms + this.timings.history_persist_ms;
    const followupTotal = this.timings.followup_seed_ms + this.timings.cohort_hydration_ms + this.timings.generation_persist_ms + this.timings.transition_evaluation_ms;

    return {
      ms_per_1000_orders: order_count > 0 ? Math.round((ingestionTotal / order_count) * 1000 * 100) / 100 : 0,
      ms_per_1000_incidents: incident_count > 0 ? Math.round((incidentTotal / incident_count) * 1000 * 100) / 100 : 0,
      ms_per_followup_case: followup_case_count > 0 ? Math.round((followupTotal / followup_case_count) * 100) / 100 : 0,
      ms_per_1000_members: followup_member_count > 0 ? Math.round((this.timings.generation_persist_ms / followup_member_count) * 1000 * 100) / 100 : 0,
    };
  }

  finalize(): CheckpointExecutionProfile {
    this.timings.total_invocation_ms = Math.round((performance.now() - this.startedAt) * 100) / 100;
    return {
      checkpoint_at: this.checkpointAt,
      sync_run_id: this.syncRunId,
      timings: { ...this.timings },
      workload: { ...this.workload },
      rates: this.calculateRates(),
      completed_at: new Date().toISOString(),
    };
  }
}
