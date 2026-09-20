import type { SupabaseClient } from "@supabase/supabase-js";
import type { IInboundOrderObservationRepository, InboundOrderObservationRow, InboundPopulationManifestInput } from "../interfaces/IInboundOrderObservationRepository";

export class SupabaseInboundOrderObservationRepository implements IInboundOrderObservationRepository {
  constructor(private readonly client: SupabaseClient) {}

  async startPopulation(input: InboundPopulationManifestInput): Promise<void> {
    const { error } = await this.client.from("inbound_population_manifests").upsert({
      ...input,
      population_status: "STARTED",
      persisted_observation_count: 0,
      population_completed_at: null,
      source_freshness: input.source_freshness,
      failure_reason: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "sync_run_id,source_system" });
    if (error) throw new Error(`InboundOrderObservationRepository.startPopulation failed: ${error.message}`);
  }

  async insertBatch(rows: InboundOrderObservationRow[], batchSize = 500): Promise<number> {
    let inserted = 0;
    for (let index = 0; index < rows.length; index += batchSize) {
      const batch = rows.slice(index, index + batchSize);
      if (!batch.length) continue;
      const { error } = await this.client
        .from("inbound_order_observations")
        .upsert(batch, { onConflict: "sync_run_id,source_system,order_code", ignoreDuplicates: true });
      if (error) throw new Error(`InboundOrderObservationRepository.insertBatch failed: ${error.message}`);
      inserted += batch.length;
    }
    return inserted;
  }

  async countPersisted(syncRunId: string, sourceSystem: "RILLNET"): Promise<number> {
    const { count, error } = await this.client
      .from("inbound_order_observations")
      .select("id", { count: "exact", head: true })
      .eq("sync_run_id", syncRunId)
      .eq("source_system", sourceSystem);
    if (error || count === null) throw new Error(`InboundOrderObservationRepository.countPersisted failed: ${error?.message || "missing count"}`);
    return count;
  }

  async completePopulation(input: InboundPopulationManifestInput & { persisted_observation_count: number; population_completed_at: string }): Promise<void> {
    const { error } = await this.client.from("inbound_population_manifests").update({
      ...input,
      population_status: "COMPLETE",
      failure_reason: null,
      updated_at: new Date().toISOString(),
    }).eq("sync_run_id", input.sync_run_id).eq("source_system", input.source_system);
    if (error) throw new Error(`InboundOrderObservationRepository.completePopulation failed: ${error.message}`);
  }

  async failPopulation(input: Pick<InboundPopulationManifestInput, "sync_run_id" | "source_system"> & { failure_reason: string }): Promise<void> {
    const { error } = await this.client.from("inbound_population_manifests").update({
      population_status: "FAILED",
      failure_reason: input.failure_reason.slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq("sync_run_id", input.sync_run_id).eq("source_system", input.source_system);
    if (error) throw new Error(`InboundOrderObservationRepository.failPopulation failed: ${error.message}`);
  }
}
