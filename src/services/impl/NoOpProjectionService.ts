import { IProjectionService } from '../interfaces/IProjectionService';
export class NoOpProjectionService implements IProjectionService {
  async rebuildProjections(): Promise<void> { throw new Error('Not implemented yet: ProjectionService.rebuildProjections'); }
}