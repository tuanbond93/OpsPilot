export interface IAiWorkerService {
  enqueueJob(jobData: any): Promise<void>;
  processPendingJobs(): Promise<void>;
}