import type { SupabaseClient } from "@supabase/supabase-js";
import { getRuntimeErrorDetails, logRuntimeMessage } from "@/observability/runtimeDiagnostics";

export type RepositoryQueryContext = {
  operation?: string;
  tableOrRpc?: string;
};

function logRepositoryQueryError(
  method: string,
  error: unknown,
  startedAt: number,
  context?: RepositoryQueryContext
): void {
  const details = getRuntimeErrorDetails(error);
  logRuntimeMessage(`[BaseRepository.${method}] error=${JSON.stringify({
    ...details,
    operation: context?.operation || "unknown",
    tableOrRpc: context?.tableOrRpc || "unknown",
    elapsedMs: Math.round(performance.now() - startedAt),
  })}`);
}

export class BaseRepository {
  constructor(protected client: SupabaseClient) {}

  /**
   * Helper to execute a Supabase query that expects a single row response.
   */
  protected async executeSingle<T>(
    queryPromise: Promise<{ data: T | null; error: any }>,
    context?: RepositoryQueryContext
  ): Promise<T> {
    const startedAt = performance.now();
    try {
      const { data, error } = await queryPromise;
      if (error) throw error;
      if (data === null) {
        throw new Error("Query returned no data (null result)");
      }
      return data;
    } catch (err: any) {
      logRepositoryQueryError("single", err, startedAt, context);
      throw err;
    }
  }

  /**
   * Helper to execute a Supabase query that expects an array response.
   */
  protected async executeMany<T>(
    queryPromise: Promise<{ data: T[] | null; error: any }>,
    context?: RepositoryQueryContext
  ): Promise<T[]> {
    const startedAt = performance.now();
    try {
      const { data, error } = await queryPromise;
      if (error) throw error;
      return data || [];
    } catch (err: any) {
      logRepositoryQueryError("many", err, startedAt, context);
      throw err;
    }
  }

  /**
   * Helper to execute a Supabase query that may return null.
   */
  protected async executeOptional<T>(
    queryPromise: Promise<{ data: T | null; error: any }>,
    context?: RepositoryQueryContext
  ): Promise<T | null> {
    const startedAt = performance.now();
    try {
      const { data, error } = await queryPromise;
      if (error) throw error;
      return data;
    } catch (err: any) {
      logRepositoryQueryError("optional", err, startedAt, context);
      throw err;
    }
  }
}
