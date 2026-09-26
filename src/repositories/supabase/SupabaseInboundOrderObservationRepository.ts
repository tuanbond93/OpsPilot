import type { SupabaseClient } from "@supabase/supabase-js";
import type { IInboundOrderObservationRepository, InboundOrderObservationRow, InboundPopulationManifest, InboundPopulationManifestInput } from "../interfaces/IInboundOrderObservationRepository";

export class SupabaseInboundOrderObservationRepository implements IInboundOrderObservationRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getPopulationManifest(syncRunId: string, sourceSystem: "RILLNET"): Promise<InboundPopulationManifest | null> {
    const { data, error } = await this.client
      .from("inbound_population_manifests")
      .select("sync_run_id,source_system,population_status,normalized_population_count,expected_observation_count,persisted_observation_count,duplicate_identical_count,duplicate_conflict_count,source_freshness,population_completed_at")
      .eq("sync_run_id", syncRunId)
      .eq("source_system", sourceSystem)
      .maybeSingle();
    if (error) throw new Error(`InboundOrderObservationRepository.getPopulationManifest failed: ${error.message}`);
    return data as InboundPopulationManifest | null;
  }

  async replaceIncompletePopulation(input: InboundPopulationManifestInput): Promise<void> {
    const { data: existingManifest, error: readError } = await this.client
      .from("inbound_population_manifests")
      .select("population_status")
      .eq("sync_run_id", input.sync_run_id)
      .eq("source_system", input.source_system)
      .maybeSingle();
    if (readError) {
      throw new Error(`InboundOrderObservationRepository.replaceIncompletePopulation failed: ${readError.message}`);
    }
    if (existingManifest?.population_status === "COMPLETE") {
      throw new Error(
        `INBOUND_POPULATION_REPLACEMENT_FORBIDDEN_COMPLETED: ${input.sync_run_id}/${input.source_system}`,
      );
    }

    const { error } = await this.client.from("inbound_population_manifests").upsert({
      ...input,
      population_status: "STARTED",
      persisted_observation_count: 0,
      population_completed_at: null,
      source_freshness: input.source_freshness,
      failure_reason: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "sync_run_id,source_system" });
    if (error) throw new Error(`InboundOrderObservationRepository.replaceIncompletePopulation failed: ${error.message}`);

    // Step 1: Determine existing persisted population count before cleanup
    const countBefore = await this.countPersisted(input.sync_run_id, input.source_system);

    // Step 2 & 3: Call the scoped cleanup RPC
    let rpcAttempted = false;
    let rpcErrorOccurred = false;
    let rpcDeletedCount: number | null = null;
    let rpcErrorMessage: string | null = null;

    try {
      const { data, error: rpcError } = await this.client.rpc(
        "clear_inbound_order_observation_population",
        {
          p_sync_run_id: input.sync_run_id,
          p_source_system: input.source_system,
        }
      );
      rpcAttempted = true;
      if (rpcError) {
        rpcErrorOccurred = true;
        rpcErrorMessage = rpcError.message;
      } else if (data !== null && data !== undefined) {
        rpcDeletedCount = Number(data);
      }
    } catch (e: any) {
      rpcErrorOccurred = true;
      rpcErrorMessage = e?.message || "RPC_FAILED";
    }

    if (rpcErrorOccurred || !rpcAttempted) {
      // Direct delete fallback
      const { error: deleteError } = await this.client
        .from("inbound_order_observations")
        .delete()
        .eq("sync_run_id", input.sync_run_id)
        .eq("source_system", input.source_system);
      if (deleteError) {
        throw new Error(
          `INBOUND_POPULATION_REPLACEMENT_FAILED: RPC failed (${rpcErrorMessage || "unknown"}), fallback delete failed: ${deleteError.message}`,
        );
      }
    } else {
      // Step 4: Verify returned deleted count
      if (countBefore > 0 && Number.isFinite(rpcDeletedCount) && rpcDeletedCount !== countBefore) {
        throw new Error(
          `INBOUND_POPULATION_REPLACEMENT_FAILED: deleted count mismatch: expected ${countBefore}, deleted ${rpcDeletedCount}`,
        );
      }
    }

    // Step 5: Verify persisted count is strictly zero after cleanup
    const countAfter = await this.countPersisted(input.sync_run_id, input.source_system);
    if (countAfter !== 0) {
      throw new Error(
        `INBOUND_POPULATION_REPLACEMENT_FAILED: residual observations remain after cleanup (${countAfter} rows)`,
      );
    }
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
    }).eq("sync_run_id", input.sync_run_id).eq("source_system", input.source_system).neq("population_status", "COMPLETE");
    if (error) throw new Error(`InboundOrderObservationRepository.failPopulation failed: ${error.message}`);
  }
}
