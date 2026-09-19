import type { SupabaseClient } from "@supabase/supabase-js";
import type { IInboundOrderObservationRepository, InboundOrderObservationRow } from "../interfaces/IInboundOrderObservationRepository";

export class SupabaseInboundOrderObservationRepository implements IInboundOrderObservationRepository {
  constructor(private readonly client: SupabaseClient) {}

  async insertBatch(rows: InboundOrderObservationRow[], batchSize = 500): Promise<number> {
    let inserted = 0;
    for (let index = 0; index < rows.length; index += batchSize) {
      const batch = rows.slice(index, index + batchSize);
      if (!batch.length) continue;
      const { error } = await this.client
        .from("inbound_order_observations")
        .upsert(batch, { onConflict: "sync_run_id,order_code", ignoreDuplicates: true });
      if (error) throw new Error(`InboundOrderObservationRepository.insertBatch failed: ${error.message}`);
      inserted += batch.length;
    }
    return inserted;
  }
}
