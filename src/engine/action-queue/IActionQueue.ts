import type { NotificationActionRow, NotificationActionEventRow, ActionStatus } from "./types";

export interface IActionQueue {
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
