import type { SupabaseClient } from "@supabase/supabase-js";
import type { IPlaybookDirectiveRepository, PlaybookDirective } from "../interfaces/IPlaybookDirectiveRepository";

/** Reads only already-approved, active deterministic policy directives. */
export class SupabasePlaybookDirectiveRepository implements IPlaybookDirectiveRepository {
  constructor(private client: SupabaseClient) {}

  async getActiveDirectives(): Promise<PlaybookDirective[]> {
    const { data, error } = await this.client
      .from("decision_playbook_directives")
      .select("id, policy_version, reason_code, followup_state, warehouse_id, zone_name, action_code, polarity, priority")
      .eq("active", true)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true });
    if (error) throw new Error(`Playbook directive lookup failed: ${error.message}`);
    return (data || []).map((row: any) => ({
      id: row.id,
      policyVersion: row.policy_version,
      reasonCode: row.reason_code,
      followupState: row.followup_state,
      warehouseId: row.warehouse_id,
      zoneName: row.zone_name,
      actionCode: row.action_code,
      polarity: row.polarity,
      priority: row.priority,
    }));
  }
}
