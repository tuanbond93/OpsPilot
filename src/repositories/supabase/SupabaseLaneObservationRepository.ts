import type { SupabaseClient } from "@supabase/supabase-js";
import type { LaneObservationRepository, LaneOrderObservationRow, LaneTransitionObservationRow } from "@/domain/lane-observation";

export class SupabaseLaneObservationRepository implements LaneObservationRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getLatestByOrderCodes(orderCodes: string[]): Promise<Map<string, LaneOrderObservationRow>> {
    const result = new Map<string, LaneOrderObservationRow>();
    for (let index = 0; index < orderCodes.length; index += 500) {
      const { data, error } = await this.client.from("lane_order_observations").select("*").in("order_code", orderCodes.slice(index, index + 500)).order("observed_at", { ascending: false });
      if (error) throw new Error(`LaneObservationRepository.getLatestByOrderCodes failed: ${error.message}`);
      for (const row of (data ?? []) as LaneOrderObservationRow[]) if (!result.has(row.order_code)) result.set(row.order_code, row);
    }
    return result;
  }

  async appendOrderObservations(rows: LaneOrderObservationRow[]): Promise<LaneOrderObservationRow[]> {
    if (!rows.length) return [];
    const { data, error } = await this.client.from("lane_order_observations").upsert(rows, { onConflict: "sync_run_id,order_code", ignoreDuplicates: true }).select("*");
    if (error) throw new Error(`LaneObservationRepository.appendOrderObservations failed: ${error.message}`);
    return (data ?? []) as LaneOrderObservationRow[];
  }

  async appendTransitions(rows: LaneTransitionObservationRow[]): Promise<number> {
    if (!rows.length) return 0;
    const { data, error } = await this.client.from("lane_transition_observations").upsert(rows, { onConflict: "source_observation_id,target_observation_id", ignoreDuplicates: true }).select("id");
    if (error) throw new Error(`LaneObservationRepository.appendTransitions failed: ${error.message}`);
    return data?.length ?? 0;
  }

  async getCompletedTransitions(fromWarehouseId: string, toWarehouseId: string): Promise<LaneTransitionObservationRow[]> {
    const { data, error } = await this.client.from("lane_transition_observations").select("*").eq("from_warehouse_id", fromWarehouseId).eq("to_warehouse_id", toWarehouseId).order("transition_window_end");
    if (error) throw new Error(`LaneObservationRepository.getCompletedTransitions failed: ${error.message}`);
    return (data ?? []) as LaneTransitionObservationRow[];
  }
}
