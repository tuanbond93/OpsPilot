import type {
  NotificationActionRow,
  NotificationActionEventRow,
  ActionStatus,
  EnqueueActionParams,
} from "./types";

export interface ActionQueueMetrics {
  enqueueCalls: number;
  dedupLookups: number;
  actionInsertCalls: number;
  auditEventWrites: number;
}

export interface ActionQueueDeduplicationResult {
  deduplicated: true;
  existingAction: NotificationActionRow;
  reason: "in_memory_duplicate" | "db_unique_constraint";
}

export interface IActionQueue {
  getMetricsSnapshot?(): ActionQueueMetrics;
  enqueueAction(
    params: EnqueueActionParams
  ): Promise<NotificationActionRow | null | ActionQueueDeduplicationResult>;
  enqueueActionBatch(
    paramsList: EnqueueActionParams[]
  ): Promise<Array<NotificationActionRow | ActionQueueDeduplicationResult | null>>;
  batchGetActionsByDedupKeys(
    dedupKeys: string[]
  ): Promise<Map<string, NotificationActionRow>>;
  batchInsertActions(
    actions: Array<Partial<NotificationActionRow>>
  ): Promise<NotificationActionRow[]>;
  batchAppendEvents(
    events: Array<Omit<NotificationActionEventRow, "id" | "created_at">>
  ): Promise<NotificationActionEventRow[]>;
  claimPendingActions(
    workerId?: string,
    limit?: number,
    lockTimeoutMs?: number,
    referenceTimeMs?: number
  ): Promise<NotificationActionRow[]>;
  updateActionStatus(
    id: string,
    status: ActionStatus,
    extra?: Partial<NotificationActionRow>
  ): Promise<NotificationActionRow | null>;
  appendEvent(
    eventData: Omit<NotificationActionEventRow, "id" | "created_at">
  ): Promise<NotificationActionEventRow>;
}
