import type { SupabaseClient } from "@supabase/supabase-js";

export class BaseRepository {
  constructor(protected client: SupabaseClient) {}

  /**
   * Helper to execute a Supabase query that expects a single row response.
   */
  protected async executeSingle<T>(
    queryPromise: Promise<{ data: T | null; error: any }>
  ): Promise<T> {
    try {
      const { data, error } = await queryPromise;
      if (error) throw error;
      if (data === null) {
        throw new Error("Query returned no data (null result)");
      }
      return data;
    } catch (err: any) {
      console.error("[BaseRepository] Error during single-row execution:", err?.message || err);
      throw err;
    }
  }

  /**
   * Helper to execute a Supabase query that expects an array response.
   */
  protected async executeMany<T>(
    queryPromise: Promise<{ data: T[] | null; error: any }>
  ): Promise<T[]> {
    try {
      const { data, error } = await queryPromise;
      if (error) throw error;
      return data || [];
    } catch (err: any) {
      console.error("[BaseRepository] Error during multi-row execution:", err?.message || err);
      throw err;
    }
  }

  /**
   * Helper to execute a Supabase query that may return null.
   */
  protected async executeOptional<T>(
    queryPromise: Promise<{ data: T | null; error: any }>
  ): Promise<T | null> {
    try {
      const { data, error } = await queryPromise;
      if (error) throw error;
      return data;
    } catch (err: any) {
      console.error("[BaseRepository] Error during optional-row execution:", err?.message || err);
      throw err;
    }
  }
}
