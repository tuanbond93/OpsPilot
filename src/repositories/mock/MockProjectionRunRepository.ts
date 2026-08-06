import type { IProjectionRunRepository } from "@/repositories/interfaces/IProjectionRunRepository";

export class MockProjectionRunRepository implements IProjectionRunRepository {
  async getLatestRun(): Promise<any> {
    return {
      id: "mock-run-1",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      status: "success",
    };
  }
}
