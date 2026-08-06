export interface DispatchSummary {
  claimedCount: number;
  sentCount: number;
  simulatedCount: number;
  failedCount: number;
  retriedCount: number;
}


export interface INotificationService {
  dispatchPending(workerId?: string, nowMs?: number, limit?: number): Promise<DispatchSummary>;
}
