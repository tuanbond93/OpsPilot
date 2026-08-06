import type { OrderExceptionRow } from "@/connectors/supabase/types";

export interface IExceptionRepository {
  getActiveExceptions(referenceTime?: string): Promise<OrderExceptionRow[]>;
  getActiveExceptionOrderCodes(referenceTime?: string): Promise<Set<string>>;
}
