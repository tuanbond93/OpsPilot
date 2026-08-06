const fs = require('fs');

const typesCode = `
export interface DispatchSummary {
  claimedCount: number;
  sentCount: number;
  simulatedCount: number;
  failedCount: number;
  retriedCount: number;
}
`;

const iNotif = `
${typesCode}

export interface INotificationService {
  dispatchPending(workerId?: string, nowMs?: number, limit?: number): Promise<DispatchSummary>;
}
`;
fs.writeFileSync('src/services/interfaces/INotificationService.ts', iNotif.trim() + '\n');

const noOp = `
import type { INotificationService, DispatchSummary } from "../interfaces/INotificationService";

export class NoOpNotificationService implements INotificationService {
  async dispatchPending(workerId?: string, nowMs?: number, limit?: number): Promise<DispatchSummary> {
    throw new Error("Not implemented yet: NotificationService.dispatchPending");
  }
}
`;
fs.writeFileSync('src/services/impl/NoOpNotificationService.ts', noOp.trim() + '\n');

// Make an IActionQueue interface
const iQueue = `
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
`;
fs.writeFileSync('src/engine/action-queue/IActionQueue.ts', iQueue.trim() + '\n');

// Implement IActionQueue in ActionQueue
let qCode = fs.readFileSync('src/engine/action-queue/queue.ts', 'utf8');
if (!qCode.includes('import type { IActionQueue }')) {
  qCode = qCode.replace('import { Deduplicator }', 'import type { IActionQueue } from "./IActionQueue";\nimport { Deduplicator }');
  qCode = qCode.replace('export class ActionQueue {', 'export class ActionQueue implements IActionQueue {');
  fs.writeFileSync('src/engine/action-queue/queue.ts', qCode);
}
