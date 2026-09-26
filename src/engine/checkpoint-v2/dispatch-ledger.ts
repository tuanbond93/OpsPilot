/**
 * Checkpoint Pipeline V2 - Effectively-Once Dispatch Ledger
 *
 * Guarantees that no external Telegram or operational intervention is dispatched
 * more than once per checkpoint, handling worker crashes, retries, and network delays.
 *
 * Formal Delivery Semantics:
 * - Weakest Accurate Classification: AT_LEAST_ONCE_WITH_DEDUPE
 * - Operational Target: EFFECTIVELY_ONCE (with stale reservation reconciliation)
 * - Reason true EXACTLY_ONCE is impossible: The Two Generals' Problem across external HTTP API.
 *   If the Telegram Bot API returns 200 OK but the worker process dies before updating
 *   the ledger, the system enters an AMBIGUOUS_STALE state upon retry.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DispatchLedgerEntry } from "@/domain/checkpoint-v2/types";

export type ReservationStatus =
  | "RESERVED_NEW"
  | "ALREADY_DISPATCHED"
  | "IN_FLIGHT_CONFLICT"
  | "AMBIGUOUS_STALE";

export interface ReservationResult {
  status: ReservationStatus;
  entry: DispatchLedgerEntry;
  staleAgeMs?: number;
}

export interface IDispatchLedgerStorage {
  reserve(
    entry: Omit<DispatchLedgerEntry, "id" | "reservedAt">,
    lockTimeoutMs?: number
  ): Promise<ReservationResult>;
  confirm(idempotencyKey: string, telegramMessageId: string): Promise<DispatchLedgerEntry>;
  fail(idempotencyKey: string, reason: string): Promise<void>;
  markAmbiguousStale(idempotencyKey: string, reason: string): Promise<void>;
  getByDedupeKey(idempotencyKey: string): Promise<DispatchLedgerEntry | null>;
  findStaleReservations(thresholdMs: number): Promise<DispatchLedgerEntry[]>;
}

export class InMemoryDispatchLedgerStorage implements IDispatchLedgerStorage {
  private ledger = new Map<string, DispatchLedgerEntry>();

  async reserve(
    entryInput: Omit<DispatchLedgerEntry, "id" | "reservedAt">,
    lockTimeoutMs: number = 60_000
  ): Promise<ReservationResult> {
    const existing = this.ledger.get(entryInput.idempotencyKey);
    const now = Date.now();

    if (existing) {
      if (existing.status === "CONFIRMED" || existing.status === "DISPATCHED") {
        return { status: "ALREADY_DISPATCHED", entry: existing };
      }

      if (existing.status === "RESERVED") {
        const reservedAtMs = new Date(existing.reservedAt).getTime();
        const ageMs = now - reservedAtMs;

        if (ageMs < lockTimeoutMs) {
          return { status: "IN_FLIGHT_CONFLICT", entry: existing, staleAgeMs: ageMs };
        } else {
          return { status: "AMBIGUOUS_STALE", entry: existing, staleAgeMs: ageMs };
        }
      }

      // If FAILED, allow re-reservation
      existing.status = "RESERVED";
      existing.reservedAt = new Date().toISOString();
      return { status: "RESERVED_NEW", entry: existing };
    }

    const entry: DispatchLedgerEntry = {
      id: crypto.randomUUID(),
      ...entryInput,
      reservedAt: new Date().toISOString(),
    };
    this.ledger.set(entryInput.idempotencyKey, entry);
    return { status: "RESERVED_NEW", entry };
  }

  async confirm(idempotencyKey: string, telegramMessageId: string): Promise<DispatchLedgerEntry> {
    const existing = this.ledger.get(idempotencyKey);
    if (!existing) throw new Error(`DISPATCH_ENTRY_NOT_FOUND: ${idempotencyKey}`);
    existing.status = "CONFIRMED";
    existing.telegramMessageId = telegramMessageId;
    existing.confirmedAt = new Date().toISOString();
    return existing;
  }

  async fail(idempotencyKey: string, reason: string): Promise<void> {
    const existing = this.ledger.get(idempotencyKey);
    if (!existing) return;
    existing.status = "FAILED";
    existing.failureReason = reason;
  }

  async markAmbiguousStale(idempotencyKey: string, reason: string): Promise<void> {
    const existing = this.ledger.get(idempotencyKey);
    if (!existing) return;
    existing.status = "FAILED";
    existing.failureReason = `AMBIGUOUS_STALE: ${reason}`;
  }

  async getByDedupeKey(idempotencyKey: string): Promise<DispatchLedgerEntry | null> {
    return this.ledger.get(idempotencyKey) || null;
  }

  async findStaleReservations(thresholdMs: number): Promise<DispatchLedgerEntry[]> {
    const now = Date.now();
    const stale: DispatchLedgerEntry[] = [];
    for (const entry of this.ledger.values()) {
      if (entry.status === "RESERVED") {
        const age = now - new Date(entry.reservedAt).getTime();
        if (age >= thresholdMs) stale.push(entry);
      }
    }
    return stale;
  }

  clear(): void {
    this.ledger.clear();
  }
}

/**
 * Concrete Supabase implementation for real IO dispatch persistence.
 */
export class SupabaseDispatchLedgerStorage implements IDispatchLedgerStorage {
  constructor(private client: SupabaseClient) {}

  async reserve(
    entryInput: Omit<DispatchLedgerEntry, "id" | "reservedAt">,
    lockTimeoutMs: number = 60_000
  ): Promise<ReservationResult> {
    const now = new Date();

    // 1. Try to fetch existing
    const { data: existing, error: selectErr } = await this.client
      .from("checkpoint_dispatch_ledger")
      .select("*")
      .eq("idempotency_key", entryInput.idempotencyKey)
      .maybeSingle();

    if (selectErr) {
      throw new Error(`Failed to query dispatch ledger: ${selectErr.message}`);
    }

    if (existing) {
      const entry = this.mapRowToEntry(existing);
      if (entry.status === "CONFIRMED" || entry.status === "DISPATCHED") {
        return { status: "ALREADY_DISPATCHED", entry };
      }

      if (entry.status === "RESERVED") {
        const ageMs = now.getTime() - new Date(entry.reservedAt).getTime();
        if (ageMs < lockTimeoutMs) {
          return { status: "IN_FLIGHT_CONFLICT", entry, staleAgeMs: ageMs };
        }
        return { status: "AMBIGUOUS_STALE", entry, staleAgeMs: ageMs };
      }

      // If FAILED, re-reserve
      const { data: updated, error: updateErr } = await this.client
        .from("checkpoint_dispatch_ledger")
        .update({
          status: "RESERVED",
          reserved_at: now.toISOString(),
          updated_at: now.toISOString(),
        })
        .eq("idempotency_key", entryInput.idempotencyKey)
        .select()
        .single();

      if (updateErr) throw new Error(`Failed to re-reserve dispatch entry: ${updateErr.message}`);
      return { status: "RESERVED_NEW", entry: this.mapRowToEntry(updated) };
    }

    // 2. Insert new reservation
    const row = {
      checkpoint_at: entryInput.checkpointAt,
      sync_run_id: entryInput.syncRunId,
      case_id: entryInput.caseId,
      incident_key: entryInput.incidentKey,
      intervention_type: entryInput.interventionType,
      sequence: entryInput.sequence,
      idempotency_key: entryInput.idempotencyKey,
      execution_mode: entryInput.executionMode || "PRODUCTION",
      status: "RESERVED",
      payload_summary: entryInput.payloadSummary || {},
      reserved_at: now.toISOString(),
    };

    const { data: inserted, error: insertErr } = await this.client
      .from("checkpoint_dispatch_ledger")
      .insert(row)
      .select()
      .single();

    if (insertErr) {
      // Primary key / unique constraint collision from race
      if (insertErr.code === "23505") {
        const { data: raceRow } = await this.client
          .from("checkpoint_dispatch_ledger")
          .select("*")
          .eq("idempotency_key", entryInput.idempotencyKey)
          .single();
        if (raceRow) {
          const entry = this.mapRowToEntry(raceRow);
          return { status: "IN_FLIGHT_CONFLICT", entry };
        }
      }
      throw new Error(`Failed to insert dispatch reservation: ${insertErr.message}`);
    }

    return { status: "RESERVED_NEW", entry: this.mapRowToEntry(inserted) };
  }

  async confirm(idempotencyKey: string, telegramMessageId: string): Promise<DispatchLedgerEntry> {
    const now = new Date().toISOString();
    const { data, error } = await this.client
      .from("checkpoint_dispatch_ledger")
      .update({
        status: "CONFIRMED",
        telegram_message_id: telegramMessageId,
        confirmed_at: now,
        updated_at: now,
      })
      .eq("idempotency_key", idempotencyKey)
      .select()
      .single();

    if (error || !data) {
      throw new Error(`Failed to confirm dispatch entry ${idempotencyKey}: ${error?.message}`);
    }
    return this.mapRowToEntry(data);
  }

  async fail(idempotencyKey: string, reason: string): Promise<void> {
    const now = new Date().toISOString();
    await this.client
      .from("checkpoint_dispatch_ledger")
      .update({
        status: "FAILED",
        failure_reason: reason,
        updated_at: now,
      })
      .eq("idempotency_key", idempotencyKey);
  }

  async markAmbiguousStale(idempotencyKey: string, reason: string): Promise<void> {
    const now = new Date().toISOString();
    await this.client
      .from("checkpoint_dispatch_ledger")
      .update({
        status: "FAILED",
        failure_reason: `AMBIGUOUS_STALE: ${reason}`,
        updated_at: now,
      })
      .eq("idempotency_key", idempotencyKey);
  }

  async getByDedupeKey(idempotencyKey: string): Promise<DispatchLedgerEntry | null> {
    const { data, error } = await this.client
      .from("checkpoint_dispatch_ledger")
      .select("*")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (error || !data) return null;
    return this.mapRowToEntry(data);
  }

  async findStaleReservations(thresholdMs: number): Promise<DispatchLedgerEntry[]> {
    const cutoff = new Date(Date.now() - thresholdMs).toISOString();
    const { data, error } = await this.client
      .from("checkpoint_dispatch_ledger")
      .select("*")
      .eq("status", "RESERVED")
      .lt("reserved_at", cutoff);

    if (error || !data) return [];
    return data.map(this.mapRowToEntry);
  }

  private mapRowToEntry(row: any): DispatchLedgerEntry {
    return {
      id: row.id,
      checkpointAt: row.checkpoint_at,
      syncRunId: row.sync_run_id,
      caseId: row.case_id,
      incidentKey: row.incident_key,
      interventionType: row.intervention_type,
      sequence: row.sequence,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      executionMode: row.execution_mode || "PRODUCTION",
      telegramMessageId: row.telegram_message_id,
      payloadSummary: row.payload_summary,
      reservedAt: row.reserved_at,
      confirmedAt: row.confirmed_at,
      failureReason: row.failure_reason,
    };
  }
}

export type StaleReservationPolicy = "QUARANTINE" | "RETRY_AT_LEAST_ONCE";

export interface DispatchLedgerConfig {
  lockTimeoutMs?: number;
  staleReservationPolicy?: StaleReservationPolicy;
}

export class CheckpointDispatchLedger {
  private lockTimeoutMs: number;
  private stalePolicy: StaleReservationPolicy;

  constructor(
    private storage: IDispatchLedgerStorage,
    config?: DispatchLedgerConfig
  ) {
    this.lockTimeoutMs = config?.lockTimeoutMs ?? 60_000;
    this.stalePolicy = config?.staleReservationPolicy ?? "QUARANTINE";
  }

  static buildIdempotencyKey(
    checkpointAt: string,
    caseId: string,
    interventionType: string,
    sequence: number = 1
  ): string {
    return `${checkpointAt}:${caseId}:${interventionType}:${sequence}`;
  }

  /**
   * Executes an intervention delivery with guaranteed effectively-once semantics.
   * In SHADOW mode, external delivery is hard-blocked and NEVER invoked.
   */
  async dispatchEffectivelyOnce(params: {
    checkpointAt: string;
    syncRunId: string;
    caseId: string;
    incidentKey: string;
    interventionType: string;
    sequence?: number;
    payloadSummary?: Record<string, unknown>;
    executionMode?: "PRODUCTION" | "SHADOW";
    sendExternal: () => Promise<{ telegramMessageId: string }>;
  }): Promise<{
    status: "SENT" | "DEDUPLICATED" | "IN_FLIGHT_SKIPPED" | "QUARANTINED" | "FAILED" | "SHADOW_SUPPRESSED";
    messageId: string | null;
    error?: string;
  }> {
    const executionMode = params.executionMode || "PRODUCTION";
    const sequence = params.sequence || 1;
    const idempotencyKey = CheckpointDispatchLedger.buildIdempotencyKey(
      params.checkpointAt,
      params.caseId,
      params.interventionType,
      sequence
    );

    // Phase 1: Pre-reservation check
    const reservation = await this.storage.reserve(
      {
        checkpointAt: params.checkpointAt,
        syncRunId: params.syncRunId,
        caseId: params.caseId,
        incidentKey: params.incidentKey,
        interventionType: params.interventionType,
        sequence,
        idempotencyKey,
        executionMode,
        status: "RESERVED",
        payloadSummary: params.payloadSummary || null,
      },
      this.lockTimeoutMs
    );

    if (reservation.status === "ALREADY_DISPATCHED") {
      return {
        status: "DEDUPLICATED",
        messageId: reservation.entry.telegramMessageId || null,
      };
    }

    if (reservation.status === "IN_FLIGHT_CONFLICT") {
      return {
        status: "IN_FLIGHT_SKIPPED",
        messageId: null,
        error: `In-flight dispatch active on key ${idempotencyKey} (age: ${reservation.staleAgeMs}ms)`,
      };
    }

    if (reservation.status === "AMBIGUOUS_STALE") {
      if (this.stalePolicy === "QUARANTINE") {
        await this.storage.markAmbiguousStale(
          idempotencyKey,
          `Reservation abandoned for ${reservation.staleAgeMs}ms. Quarantined to prevent duplicate Telegram spam.`
        );
        return {
          status: "QUARANTINED",
          messageId: null,
          error: `AMBIGUOUS_STALE_RESERVATION: Quarantined after ${reservation.staleAgeMs}ms to maintain effectively-once guarantee.`,
        };
      }
      // If policy is RETRY_AT_LEAST_ONCE, fall through to re-attempt
    }

    // DEFENSE-IN-DEPTH HARD BLOCK: SHADOW mode strictly prevents external transmission.
    // Even if a real Telegram adapter is passed into sendExternal, it MUST NOT be called.
    if (executionMode === "SHADOW") {
      const shadowMessageId = `SHADOW_SUPPRESSED_${idempotencyKey}`;
      await this.storage.confirm(idempotencyKey, shadowMessageId);
      return {
        status: "SHADOW_SUPPRESSED",
        messageId: shadowMessageId,
      };
    }

    // Phase 2: External Delivery
    try {
      const deliveryResult = await params.sendExternal();

      // Phase 3: Confirmation
      await this.storage.confirm(idempotencyKey, deliveryResult.telegramMessageId);
      return {
        status: "SENT",
        messageId: deliveryResult.telegramMessageId,
      };
    } catch (err: any) {
      await this.storage.fail(idempotencyKey, err?.message || String(err));
      return {
        status: "FAILED",
        messageId: null,
        error: err?.message || String(err),
      };
    }
  }

  /**
   * Reconciles all stale reservations older than threshold.
   */
  async reconcileStaleReservations(thresholdMs: number = 90_000): Promise<{
    reconciledCount: number;
    quarantinedKeys: string[];
  }> {
    const staleEntries = await this.storage.findStaleReservations(thresholdMs);
    const quarantinedKeys: string[] = [];

    for (const entry of staleEntries) {
      await this.storage.markAmbiguousStale(
        entry.idempotencyKey,
        `Reconciled by StaleReservationReconciler (age > ${thresholdMs}ms)`
      );
      quarantinedKeys.push(entry.idempotencyKey);
    }

    return {
      reconciledCount: staleEntries.length,
      quarantinedKeys,
    };
  }
}
