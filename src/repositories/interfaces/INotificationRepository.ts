import type { NotificationActionRow, NotificationActionEventRow } from "@/engine/action-queue/types";

export interface INotificationRepository {
  enqueueAction(action: Partial<NotificationActionRow>): Promise<NotificationActionRow>;
  claimActions(workerId: string, limit?: number): Promise<NotificationActionRow[]>;
  updateActionStatus(id: string, status: string, extra?: any): Promise<NotificationActionRow | null>;
  appendActionEvent(event: Omit<NotificationActionEventRow, "id" | "created_at">): Promise<NotificationActionEventRow>;
  getRecentActionEvents(limit?: number): Promise<NotificationActionEventRow[]>;
}
