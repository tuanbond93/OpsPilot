export interface InboundOrderObservationRow {
  sync_run_id: string;
  order_code: string;
  current_warehouse_id?: string | null;
  deliver_warehouse_id?: string | null;
  source_status: string;
  end_pick_at?: string | null;
  weight_kg?: number | null;
  is_b2b?: boolean | null;
  source_observed_at: string;
}

export interface IInboundOrderObservationRepository {
  insertBatch(rows: InboundOrderObservationRow[], batchSize?: number): Promise<number>;
}
