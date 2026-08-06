import type { IExceptionRepository } from "../interfaces/IExceptionRepository";
import type { OrderExceptionRow } from "@/connectors/supabase/types";

export class MockExceptionRepository implements IExceptionRepository {
  async getActiveExceptions(referenceTime?: string): Promise<OrderExceptionRow[]> {
    return [];
  }
  async getActiveExceptionOrderCodes(referenceTime?: string): Promise<Set<string>> {
    return new Set();
  }
}
