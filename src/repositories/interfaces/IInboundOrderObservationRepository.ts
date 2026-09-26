export interface InboundOrderObservationRow {
  sync_run_id: string;
  source_system: "RILLNET";
  order_code: string;
  current_warehouse_id?: string | null;
  deliver_warehouse_id?: string | null;
  source_status: string;
  end_pick_at?: string | null;
  weight_kg?: number | null;
  is_b2b?: boolean | null;
  source_observed_at: string;
}

export interface InboundPopulationManifestInput {
  sync_run_id: string;
  source_system: "RILLNET";
  normalized_population_count: number;
  expected_observation_count: number;
  duplicate_identical_count: number;
  duplicate_conflict_count: number;
  /** The Rillnet snapshot updatedAt value; never a local completion timestamp. */
  source_freshness: string | null;
}

export interface InboundPopulationManifest extends InboundPopulationManifestInput {
  population_status: "STARTED" | "COMPLETE" | "FAILED";
  persisted_observation_count: number;
  population_completed_at?: string | null;
  failure_reason?: string | null;
}

export interface IInboundOrderObservationRepository {
  getPopulationManifest(syncRunId: string, sourceSystem: "RILLNET"): Promise<InboundPopulationManifest | null>;

  /**
   * Mark an incomplete population as rebuildable and remove its prior rows.
   *
   * This is intentionally separate from insertBatch: a resumed run must not
   * leave an older attempt's rows in the exact-count population. Completed
   * populations are immutable and must be rejected.
   */
  replaceIncompletePopulation(input: InboundPopulationManifestInput): Promise<void>;
  insertBatch(rows: InboundOrderObservationRow[], batchSize?: number): Promise<number>;
  countPersisted(syncRunId: string, sourceSystem: "RILLNET"): Promise<number>;
  completePopulation(input: InboundPopulationManifestInput & { persisted_observation_count: number; population_completed_at: string }): Promise<void>;
  failPopulation(input: Pick<InboundPopulationManifestInput, "sync_run_id" | "source_system"> & { failure_reason: string }): Promise<void>;
}
