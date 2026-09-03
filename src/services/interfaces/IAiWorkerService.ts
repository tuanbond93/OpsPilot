export interface IAiWorkerService {
  enqueueJob(jobData: any): Promise<void>;
  processPendingJobs(workerId?: string, maxJobs?: number, incidentId?: string): Promise<any>;
}
