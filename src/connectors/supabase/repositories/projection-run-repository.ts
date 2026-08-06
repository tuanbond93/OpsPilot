import type { IProjectionRunRepository } from "@/repositories/interfaces/IProjectionRunRepository";

export class SupabaseProjectionRunRepository implements IProjectionRunRepository {
  constructor(private client: any) {}

  async getLatestRun(): Promise<any> {
    if (!this.client) return null;
    const { data, error } = await this.client
      .from("projection_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(1)
      .single();

    if (error) {
      throw new Error(error.message);
    }
    return data;
  }
}
