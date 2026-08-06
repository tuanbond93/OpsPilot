import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrderExceptionRow } from "@/connectors/supabase/types";
import type { IExceptionRepository } from "../interfaces/IExceptionRepository";

export class SupabaseExceptionRepository implements IExceptionRepository {
  constructor(private client: SupabaseClient) {}

  /**
   * Fetches active, non-expired order exception records
   */
  async getActiveExceptions(
    referenceTime: string = new Date().toISOString()
  ): Promise<OrderExceptionRow[]> {
    const { data, error } = await this.client
      .from("order_exceptions")
      .select("*")
      .eq("active", true)
      .or(`expires_at.is.null,expires_at.gt.${referenceTime}`);

    if (error) {
      // If table doesn't exist yet or query fails, return empty array safely
      return [];
    }

    return (data || []) as OrderExceptionRow[];
  }

  /**
   * Fetches set of active order codes to exclude
   */
  async getActiveExceptionOrderCodes(
    referenceTime: string = new Date().toISOString()
  ): Promise<Set<string>> {
    const exceptions = await this.getActiveExceptions(referenceTime);
    return new Set(exceptions.map((e) => e.order_code.trim()));
  }
}
