import type { IProjectionService } from "../interfaces/IProjectionService";

export class NoOpProjectionService implements IProjectionService {
  async refreshProjections(): Promise<void> {
    throw new Error("Not implemented yet: ProjectionService.refreshProjections");
  }
  async rebuildProjections(): Promise<void> {
    throw new Error("Not implemented yet: ProjectionService.rebuildProjections");
  }
  async getLatestRun(): Promise<any> {
    throw new Error("Not implemented yet: ProjectionService.getLatestRun");
  }
}