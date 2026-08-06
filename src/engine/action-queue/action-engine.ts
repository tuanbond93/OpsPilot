import type { SupabaseClient } from "@supabase/supabase-js";
import { ActionQueue, type DeduplicationResult } from "./queue";
import type { EnqueueActionParams, NotificationActionRow } from "./types";

export class ActionEngine {
  private queue: ActionQueue;

  constructor(client?: SupabaseClient | null) {
    this.queue = new ActionQueue(client);
  }

  getQueue(): ActionQueue {
    return this.queue;
  }

  async enqueue(params: EnqueueActionParams): Promise<NotificationActionRow | DeduplicationResult | null> {
    return this.queue.enqueueAction(params);
  }
}
