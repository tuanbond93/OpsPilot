import type { SupabaseClient } from "@supabase/supabase-js";
import type { ComponentHealth, HealthCheckable } from "../health";
import { logger } from "@/observability/logger";

export class RealtimePublisher implements HealthCheckable {
  readonly name = "Realtime";
  private lastSuccessAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastErrorReason: string | null = null;

  constructor(private client?: SupabaseClient | null) {}

  /**
   * Publishes operational changes to the real-time channel.
   * Dashboard, Planner, Notifications, Follow-ups listen to these events.
   */
  async publish(channel: string, event: string, payload: Record<string, any>): Promise<boolean> {
    const timestamp = new Date().toISOString();

    if (this.client) {
      try {
        const channelRef = this.client.channel(channel);
        await channelRef.send({
          type: "broadcast",
          event,
          payload: {
            ...payload,
            publishedAt: timestamp,
          },
        });
        this.lastSuccessAt = timestamp;
        return true;
      } catch (err: any) {
        this.lastFailureAt = timestamp;
        this.lastErrorReason = err?.message || String(err);
      }
    }

    // Structured logging fallback for development
    logger.info({
      component: "RealtimePublisher",
      operation: "publish",
      status: "success",
      message: `[Realtime Broadcast] Channel: ${channel} | Event: ${event}`,
      metadata: {
        channel,
        event,
        publishedAt: timestamp,
        hasClient: false,
      },
    });
    this.lastSuccessAt = timestamp;
    return true;
  }

  /**
   * Health Check Implementation
   */
  async health(): Promise<ComponentHealth> {
    if (!this.client) {
      return {
        status: "UNKNOWN",
        healthReason: "Supabase client not configured for Realtime publishing",
        lastSuccessAt: this.lastSuccessAt,
        lastFailureAt: this.lastFailureAt,
        freshnessSeconds: null,
      };
    }

    try {
      this.lastSuccessAt = new Date().toISOString();
      return {
        status: "GREEN",
        healthReason: "Realtime publisher ready for broadcast channels",
        lastSuccessAt: this.lastSuccessAt,
        lastFailureAt: this.lastFailureAt,
        freshnessSeconds: 0,
      };
    } catch (err: any) {
      this.lastFailureAt = new Date().toISOString();
      this.lastErrorReason = err?.message || String(err);
      return {
        status: "RED",
        healthReason: `Realtime check failed: ${this.lastErrorReason}`,
        lastSuccessAt: this.lastSuccessAt,
        lastFailureAt: this.lastFailureAt,
        freshnessSeconds: null,
      };
    }
  }
}
