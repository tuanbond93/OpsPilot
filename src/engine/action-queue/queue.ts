import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  NotificationActionRow,
  NotificationActionEventRow,
  EnqueueActionParams,
  ActionStatus,
  AuditEventType,
} from "./types";
import { Deduplicator } from "./deduplicator";
import { isFallbackAllowed } from "@/connectors/supabase/fallback-policy";

export interface DeduplicationResult {
  deduplicated: true;
  existingAction: NotificationActionRow;
  reason: "in_memory_duplicate" | "db_unique_constraint";
}

export class ActionQueue {
  private inMemoryQueue: NotificationActionRow[] = [];
  private inMemoryEvents: NotificationActionEventRow[] = [];

  constructor(private client?: SupabaseClient | null) {}

  /**
   * Enqueues a notification action with deduplication check and audit event logging.
   * Returns the new action, an existing action (wrapped in DeduplicationResult), or null.
   */
  async enqueueAction(
    params: EnqueueActionParams
  ): Promise<NotificationActionRow | DeduplicationResult | null> {
    const dedupKey = params.deduplicationKey || null;
    const nowIso = new Date().toISOString();

    // In-memory dedup check
    if (dedupKey && Deduplicator.isDuplicateInMemory(dedupKey)) {
      const existing = await this.getActionByDeduplicationKey(dedupKey);
      if (existing) {
        await this.appendEvent({
          action_id: existing.id,
          event_type: "ACTION_DEDUPLICATED",
          old_status: existing.status,
          new_status: existing.status,
          attempt_number: 0,
          provider: params.provider || "console",
          metadata: {
            deduplicationKey: dedupKey,
            attemptedActionType: params.actionType,
            reason: "in_memory_duplicate",
            attemptedAt: nowIso,
          },
        });
        return { deduplicated: true, existingAction: existing, reason: "in_memory_duplicate" };
      }
      // Key in memory but action not found — should not happen, but return null safely
      return null;
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

    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("notification_actions")
          .insert([actionRow])
          .select()
          .single();

        if (error) {
          if (error.code === "23505") { // Unique constraint violation
            if (dedupKey) Deduplicator.markKeyInMemory(dedupKey);
            // Fetch the existing action to get its real UUID
            const existing = dedupKey
              ? await this.getActionByDeduplicationKey(dedupKey)
              : null;
            if (existing) {
              await this.appendEvent({
                action_id: existing.id,
                event_type: "ACTION_DEDUPLICATED",
                old_status: existing.status,
                new_status: existing.status,
                attempt_number: 0,
                provider: params.provider || "console",
                metadata: {
                  deduplicationKey: dedupKey,
                  attemptedActionType: params.actionType,
                  reason: "db_unique_constraint",
                  attemptedAt: nowIso,
                },
              });
              return { deduplicated: true, existingAction: existing, reason: "db_unique_constraint" };
            }
            return null;
          }
          throw error;
        }

        if (dedupKey) Deduplicator.markKeyInMemory(dedupKey);
        await this.appendEvent({
          action_id: data.id,
          event_type: "ACTION_ENQUEUED",
          old_status: null,
          new_status: "PENDING",
          attempt_number: 0,
          provider: data.provider,
          metadata: { payload: data.payload },
        });

        return data;
      } catch {
        // Fallback
      }
    }

    // In-memory fallback
    const id = `act-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const fullRow: NotificationActionRow = {
      id,
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

    if (dedupKey) Deduplicator.markKeyInMemory(dedupKey);
    this.inMemoryQueue.push(fullRow);

    await this.appendEvent({
      action_id: id,
      event_type: "ACTION_ENQUEUED",
      old_status: null,
      new_status: "PENDING",
      attempt_number: 0,
      provider: fullRow.provider,
      metadata: { payload: fullRow.payload },
    });

    return fullRow;
  }

  /**
   * Finds a notification action by its deduplication_key.
   */
  async getActionByDeduplicationKey(dedupKey: string): Promise<NotificationActionRow | null> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("notification_actions")
          .select("*")
          .eq("deduplication_key", dedupKey)
          .maybeSingle();

        if (!error && data) return data;
      } catch {
        // Fallback
      }
    }

    return this.inMemoryQueue.find((a) => a.deduplication_key === dedupKey) || null;
  }

  /**
   * Database-backed atomic claim mechanism.
   * Prevents concurrent workers from processing the same action.
   * Recovers actions stuck in PROCESSING beyond lockTimeoutMs.
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
        // 1. Fetch eligible actions (PENDING or stale PROCESSING)
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

    // In-memory fallback claim implementation
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
    const nowIso = new Date().toISOString();

    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("notification_action_events")
          .insert([{ ...eventData, created_at: nowIso }])
          .select()
          .single();

        if (!error && data) return data;
      } catch {
        // Fallback
      }
    }

    const eventRow: NotificationActionEventRow = {
      id: `evt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      ...eventData,
      created_at: nowIso,
    };
    this.inMemoryEvents.push(eventRow);
    return eventRow;
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
