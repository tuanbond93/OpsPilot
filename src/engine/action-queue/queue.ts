import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  NotificationActionRow,
  NotificationActionEventRow,
  EnqueueActionParams,
  ActionStatus,
} from "./types";
import type { ActionQueueMetrics, IActionQueue, ActionQueueDeduplicationResult } from "./IActionQueue";
import { Deduplicator } from "./deduplicator";
import { isFallbackAllowed } from "@/connectors/supabase/fallback-policy";

export interface DeduplicationResult extends ActionQueueDeduplicationResult {}

export class ActionQueue implements IActionQueue {
  private inMemoryQueue: NotificationActionRow[] = [];
  private inMemoryEvents: NotificationActionEventRow[] = [];
  private metrics: ActionQueueMetrics = { enqueueCalls: 0, dedupLookups: 0, actionInsertCalls: 0, auditEventWrites: 0 };

  constructor(private client?: SupabaseClient | null) {}

  getMetricsSnapshot(): ActionQueueMetrics {
    return { ...this.metrics };
  }

  /**
   * Bulk query notification_actions by deduplication keys in chunks
   */
  async batchGetActionsByDedupKeys(dedupKeys: string[]): Promise<Map<string, NotificationActionRow>> {
    const resultMap = new Map<string, NotificationActionRow>();
    const validKeys = Array.from(new Set(dedupKeys.filter(Boolean)));
    if (validKeys.length === 0) return resultMap;

    if (this.client) {
      this.metrics.dedupLookups++;
      try {
        const chunkSize = 100;
        for (let i = 0; i < validKeys.length; i += chunkSize) {
          const chunk = validKeys.slice(i, i + chunkSize);
          const { data, error } = await this.client
            .from("notification_actions")
            .select("*")
            .in("deduplication_key", chunk);

          if (!error && data) {
            for (const row of data) {
              if (row.deduplication_key) {
                resultMap.set(row.deduplication_key, row);
              }
            }
          }
        }
        return resultMap;
      } catch {
        // Fallback to in-memory
      }
    }

    for (const key of validKeys) {
      const match = this.inMemoryQueue.find((a) => a.deduplication_key === key);
      if (match) resultMap.set(key, match);
    }
    return resultMap;
  }

  /**
   * Bulk insert notification_actions in chunks
   */
  async batchInsertActions(actions: Array<Partial<NotificationActionRow>>): Promise<NotificationActionRow[]> {
    if (actions.length === 0) return [];

    if (this.client) {
      this.metrics.actionInsertCalls++;
      try {
        const insertedRows: NotificationActionRow[] = [];
        const chunkSize = 100;
        for (let i = 0; i < actions.length; i += chunkSize) {
          const chunk = actions.slice(i, i + chunkSize);
          const { data, error } = await this.client
            .from("notification_actions")
            .insert(chunk)
            .select();

          if (error) throw error;
          if (data) insertedRows.push(...data);
        }
        return insertedRows;
      } catch {
        // Fallback to in-memory below
      }
    }

    const nowIso = new Date().toISOString();
    const fallbackRows: NotificationActionRow[] = actions.map((p) => {
      const id = p.id || `act-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      return {
        id,
        action_type: p.action_type || "CUSTOM",
        provider: p.provider || "console",
        target_type: p.target_type || "WAREHOUSE",
        target_id: p.target_id || null,
        payload: p.payload || {},
        status: p.status || "PENDING",
        priority: p.priority || "medium",
        deduplication_key: p.deduplication_key || null,
        retry_count: p.retry_count || 0,
        max_retry: p.max_retry || 3,
        scheduled_at: p.scheduled_at || nowIso,
        created_at: p.created_at || nowIso,
        updated_at: p.updated_at || nowIso,
      };
    });

    this.inMemoryQueue.push(...fallbackRows);
    return fallbackRows;
  }

  /**
   * Bulk insert notification_action_events in chunks
   */
  async batchAppendEvents(events: Array<Omit<NotificationActionEventRow, "id" | "created_at">>): Promise<NotificationActionEventRow[]> {
    if (events.length === 0) return [];
    const nowIso = new Date().toISOString();

    if (this.client) {
      this.metrics.auditEventWrites++;
      try {
        const insertedEvents: NotificationActionEventRow[] = [];
        const payloadEvents = events.map((e) => ({ ...e, created_at: nowIso }));
        const chunkSize = 100;

        for (let i = 0; i < payloadEvents.length; i += chunkSize) {
          const chunk = payloadEvents.slice(i, i + chunkSize);
          const { data, error } = await this.client
            .from("notification_action_events")
            .insert(chunk)
            .select();

          if (error) throw error;
          if (data) insertedEvents.push(...data);
        }
        return insertedEvents;
      } catch {
        // Fallback
      }
    }

    const fallbackEvents: NotificationActionEventRow[] = events.map((e) => ({
      id: `evt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      ...e,
      created_at: nowIso,
    }));
    this.inMemoryEvents.push(...fallbackEvents);
    return fallbackEvents;
  }

  /**
   * Enqueues a batch of notification action parameters efficiently in bulk
   */
  async enqueueActionBatch(
    paramsList: EnqueueActionParams[]
  ): Promise<Array<NotificationActionRow | ActionQueueDeduplicationResult | null>> {
    if (paramsList.length === 0) return [];
    const tStart = performance.now();
    this.metrics.enqueueCalls += paramsList.length;
    const nowIso = new Date().toISOString();

    const dedupKeys = paramsList.map((p) => p.deduplicationKey).filter(Boolean) as string[];
    const existingMap = await this.batchGetActionsByDedupKeys(dedupKeys);

    const results: Array<NotificationActionRow | ActionQueueDeduplicationResult | null> = new Array(paramsList.length).fill(null);
    const actionsToInsert: Array<{ index: number; row: Partial<NotificationActionRow> }> = [];
    const eventsToAppend: Array<Omit<NotificationActionEventRow, "id" | "created_at">> = [];
    const seenBatchKeys = new Map<string, NotificationActionRow>();

    for (let i = 0; i < paramsList.length; i++) {
      const params = paramsList[i];
      const dedupKey = params.deduplicationKey || null;

      if (dedupKey) {
        const existingInDb = existingMap.get(dedupKey) || seenBatchKeys.get(dedupKey);
        const isMemDup = Deduplicator.isDuplicateInMemory(dedupKey);

        if (existingInDb || isMemDup) {
          const existingRow = existingInDb || (await this.getActionByDeduplicationKey(dedupKey));
          if (existingRow) {
            const reason = isMemDup ? "in_memory_duplicate" : "db_unique_constraint";
            results[i] = {
              deduplicated: true,
              existingAction: existingRow,
              reason,
            };
            eventsToAppend.push({
              action_id: existingRow.id,
              event_type: "ACTION_DEDUPLICATED",
              old_status: existingRow.status,
              new_status: existingRow.status,
              attempt_number: 0,
              provider: params.provider || "console",
              metadata: {
                deduplicationKey: dedupKey,
                attemptedActionType: params.actionType,
                reason,
                attemptedAt: nowIso,
              },
            });
            continue;
          }
        }
      }

      const actionRow: Partial<NotificationActionRow> = {
        action_type: params.actionType,
        provider: params.provider || "console",
        target_type: params.targetType || "WAREHOUSE",
        target_id: params.targetId || null,
        payload: params.payload || {},
        status: "PENDING",
        priority: params.priority || "medium",
        deduplication_key: dedupKey,
        retry_count: 0,
        max_retry: params.maxRetry || 3,
        scheduled_at: params.scheduledAt || nowIso,
        created_at: nowIso,
        updated_at: nowIso,
      };

      if (dedupKey) {
        Deduplicator.markKeyInMemory(dedupKey);
        seenBatchKeys.set(dedupKey, actionRow as NotificationActionRow);
      }

      actionsToInsert.push({ index: i, row: actionRow });
    }

    if (actionsToInsert.length > 0) {
      const insertedRows = await this.batchInsertActions(actionsToInsert.map((a) => a.row));

      for (let k = 0; k < actionsToInsert.length; k++) {
        const { index, row } = actionsToInsert[k];
        const inserted = insertedRows[k] || ({
          id: `act-${Date.now()}-${k}`,
          ...row,
        } as NotificationActionRow);

        results[index] = inserted;
        if (inserted.deduplication_key) {
          seenBatchKeys.set(inserted.deduplication_key, inserted);
        }

        eventsToAppend.push({
          action_id: inserted.id,
          event_type: "ACTION_ENQUEUED",
          old_status: null,
          new_status: "PENDING",
          attempt_number: 0,
          provider: inserted.provider,
          metadata: { payload: inserted.payload },
        });
      }
    }

    if (eventsToAppend.length > 0) {
      await this.batchAppendEvents(eventsToAppend);
    }

    const durationMs = Math.round(performance.now() - tStart);
    const existingCount = paramsList.length - actionsToInsert.length;
    const insertedCount = actionsToInsert.length;
    const repositoryCalls = (dedupKeys.length > 0 ? 1 : 0) + (insertedCount > 0 ? 1 : 0) + (eventsToAppend.length > 0 ? 1 : 0);

    console.log(
      `[ActionQueue] operation=batchEnqueue candidates=${paramsList.length} existing=${existingCount} inserted=${insertedCount} events=${eventsToAppend.length} repositoryCalls=${repositoryCalls} durationMs=${durationMs} status=success`
    );

    return results;
  }

  /**
   * Enqueues a single notification action with deduplication check and audit event logging.
   */
  async enqueueAction(
    params: EnqueueActionParams
  ): Promise<NotificationActionRow | ActionQueueDeduplicationResult | null> {
    const res = await this.enqueueActionBatch([params]);
    return res[0] || null;
  }

  /**
   * Finds a notification action by its deduplication_key.
   */
  async getActionByDeduplicationKey(dedupKey: string): Promise<NotificationActionRow | null> {
    const map = await this.batchGetActionsByDedupKeys([dedupKey]);
    return map.get(dedupKey) || null;
  }

  /**
   * Database-backed atomic claim mechanism.
   * Prevents concurrent workers from processing the same action.
   */
  async claimPendingActions(
    workerId: string = "worker-1",
    limit: number = 10,
    lockTimeoutMs: number = 300000,
    referenceTimeMs: number = Date.now()
  ): Promise<NotificationActionRow[]> {
    const refIso = new Date(referenceTimeMs).toISOString();
    const staleLockThresholdIso = new Date(referenceTimeMs - lockTimeoutMs).toISOString();

    if (this.client) {
      try {
        const { data: eligible, error: selectErr } = await this.client
          .from("notification_actions")
          .select("*")
          .or(`status.eq.PENDING,and(status.eq.PROCESSING,locked_at.lt.${staleLockThresholdIso})`)
          .lte("scheduled_at", refIso)
          .order("priority", { ascending: false })
          .order("created_at", { ascending: true })
          .limit(limit);

        if (selectErr || !eligible || eligible.length === 0) {
          return [];
        }

        const claimed: NotificationActionRow[] = [];
        for (const action of eligible) {
          const isRecovery = action.status === "PROCESSING";
          const { data: updated, error: updateErr } = await this.client
            .from("notification_actions")
            .update({
              status: "PROCESSING",
              locked_at: refIso,
              locked_by: workerId,
              attempt_started_at: refIso,
              updated_at: refIso,
            })
            .eq("id", action.id)
            .or(`status.eq.PENDING,and(status.eq.PROCESSING,locked_at.lt.${staleLockThresholdIso})`)
            .select()
            .single();

          if (!updateErr && updated) {
            claimed.push(updated);
            await this.appendEvent({
              action_id: updated.id,
              event_type: isRecovery ? "PROCESSING_RECOVERED" : "ACTION_CLAIMED",
              old_status: action.status,
              new_status: "PROCESSING",
              attempt_number: updated.retry_count + 1,
              provider: updated.provider,
              metadata: { workerId, isRecovery },
            });
          }
        }

        return claimed;
      } catch {
        // Fallback
      }
    }

    const claimed: NotificationActionRow[] = [];
    for (const action of this.inMemoryQueue) {
      if (claimed.length >= limit) break;

      const isPending = action.status === "PENDING" && new Date(action.scheduled_at).getTime() <= referenceTimeMs;
      const isStale =
        action.status === "PROCESSING" &&
        (!action.locked_at || new Date(action.locked_at).getTime() < referenceTimeMs - lockTimeoutMs);

      if (isPending || isStale) {
        const oldStatus = action.status;
        action.status = "PROCESSING";
        action.locked_at = refIso;
        action.locked_by = workerId;
        action.attempt_started_at = refIso;
        action.updated_at = refIso;
        claimed.push(action);

        await this.appendEvent({
          action_id: action.id,
          event_type: isStale ? "PROCESSING_RECOVERED" : "ACTION_CLAIMED",
          old_status: oldStatus,
          new_status: "PROCESSING",
          attempt_number: action.retry_count + 1,
          provider: action.provider,
          metadata: { workerId, isStale },
        });
      }
    }

    return claimed;
  }

  async updateActionStatus(
    id: string,
    status: ActionStatus,
    extra: Partial<NotificationActionRow> = {}
  ): Promise<NotificationActionRow | null> {
    const nowIso = new Date().toISOString();

    if (this.client) {
      try {
        const payload: any = {
          status,
          updated_at: nowIso,
          ...extra,
        };

        const { data, error } = await this.client
          .from("notification_actions")
          .update(payload)
          .eq("id", id)
          .select()
          .single();

        if (!error && data) return data;
      } catch {
        // Fallback
      }
    }

    const item = this.inMemoryQueue.find((a) => a.id === id);
    if (item) {
      item.status = status;
      item.updated_at = nowIso;
      Object.assign(item, extra);
      return item;
    }

    return null;
  }

  async appendEvent(
    eventData: Omit<NotificationActionEventRow, "id" | "created_at">
  ): Promise<NotificationActionEventRow> {
    const res = await this.batchAppendEvents([eventData]);
    return res[0];
  }

  async getActionEvents(actionId: string): Promise<NotificationActionEventRow[]> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("notification_action_events")
          .select("*")
          .eq("action_id", actionId)
          .order("created_at", { ascending: true });

        if (!error && data) return data;
      } catch {
        // Fallback
      }
    }

    return this.inMemoryEvents
      .filter((e) => e.action_id === actionId)
      .sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime());
  }

  async getActionById(id: string): Promise<NotificationActionRow | null> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("notification_actions")
          .select("*")
          .eq("id", id)
          .maybeSingle();

        if (!error && data) return data;
      } catch {
        // Fallback
      }
    }

    return this.inMemoryQueue.find((a) => a.id === id) || null;
  }

  async getAllActions(): Promise<NotificationActionRow[]> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("notification_actions")
          .select("*")
          .order("created_at", { ascending: false });

        if (!error && data) return data;
        if (!isFallbackAllowed()) throw error || new Error("getAllActions DB query failed");
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    return [...this.inMemoryQueue].sort(
      (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
    );
  }

  async getRecentEvents(limit: number = 30): Promise<NotificationActionEventRow[]> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("notification_action_events")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(limit);

        if (!error && data) return data;
        if (!isFallbackAllowed()) throw error || new Error("getRecentEvents DB query failed");
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    return [...this.inMemoryEvents]
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      .slice(0, limit);
  }
}
