import { IAiWorkerService } from '../interfaces/IAiWorkerService';
export class NoOpAiWorkerService implements IAiWorkerService {
  async enqueueJob(jobData: any): Promise<void> { throw new Error('Not implemented yet: AiWorkerService.enqueueJob'); }
  async processPendingJobs(): Promise<void> { throw new Error('Not implemented yet: AiWorkerService.processPendingJobs'); }
}