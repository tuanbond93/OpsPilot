import { logger } from "@/observability/logger";
/**
 * NotificationGateway — Central entry point for all outbound operational messages.
 *
 * This is the core abstraction that decouples:
 *   "OpsPilot decides what to do"
 * from:
 *   "How it's delivered, to whom, through which channel, and how managers observe it"
 *
 * DESIGN PRINCIPLES:
 * 1. Business logic calls gateway.send() — never TelegramClient directly.
 * 2. Feature flags control routing: OFF → legacy, SHADOW → log only, PRIVATE → DM.
 * 3. Mirror failures NEVER affect employee delivery.
 * 4. Audit trail written for every delivery attempt.
 * 5. Idempotency prevents duplicate sends.
 * 6. Deny by default — unauthorized scope → quarantine.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { TelegramDeliveryProvider } from "./delivery-provider";
import { PrivateDeliveryProvider } from "./private-delivery";
import { ManagerMirrorService } from "./mirror";
import { buildIdempotencyKey, checkDuplicate } from "./deduplication";
import { resolveAuthorizedRecipients, resolveProvince, resolveRegion, type ScopeContext } from "./scope-resolver";
import { formatAttentionMessage, isDeliveryFailureAttentionWorthy, isRoutingFailureAttentionWorthy, type AttentionEvent } from "./attention";
import { resolveRoutingMode, isMirrorEnabled, type RoutingMode } from "../../config/feature-flags";
import { getProvinceCode } from "../../config/pilot-provinces";
import type {
  DeliveryRequest,
  DeliveryResult,
  DeliveryAudience,
  DeliveryStatus,
} from "./types";

export { type DeliveryRequest, type DeliveryResult, type DeliveryAudience };

export interface GatewaySendResult {
  /** Primary delivery result (employee notification) */
  primary: DeliveryResult;
  /** Mirror delivery result (manager control tower), null if mirror disabled */
  mirror: DeliveryResult | null;
  /** Shadow log entry, null if not in shadow mode */
  shadowLog: string | null;
  /** Routing mode that was applied */
  routingMode: RoutingMode;
  /** Whether deduplication prevented this send */
  deduplicated: boolean;
}

export class NotificationGateway {
  private legacyProvider: TelegramDeliveryProvider;
  private privateProvider: PrivateDeliveryProvider;
  private mirrorService: ManagerMirrorService;

  constructor(
    legacyProvider?: TelegramDeliveryProvider,
    privateProvider?: PrivateDeliveryProvider,
    mirrorService?: ManagerMirrorService
  ) {
    this.legacyProvider = legacyProvider || new TelegramDeliveryProvider();
    this.privateProvider = privateProvider || new PrivateDeliveryProvider();
    this.mirrorService = mirrorService || new ManagerMirrorService();
  }

  /**
   * Sends an operational notification through the gateway.
   *
   * Routing flow:
   * 1. Resolve province → routing mode from feature flags
   * 2. Check idempotency
   * 3. Route to delivery strategy (LEGACY / SHADOW / PRIVATE / PRIVATE_WITH_FALLBACK)
   * 4. Record audit trail
   * 5. Send mirror to Control Tower (if enabled)
   * 6. Return structured result
   */
  async send(
    request: DeliveryRequest,
    client: SupabaseClient
  ): Promise<GatewaySendResult> {
    // 1. Determine routing mode
    const province = resolveProvince({
      province: request.audience.province,
      warehouse: request.audience.warehouse,
      warehouseId: request.audience.warehouseId,
      region: request.audience.region,
    });
    const provinceCode = request.audience.provinceCode || getProvinceCode(province);
    const routingMode = resolveRoutingMode(provinceCode);

    // 2. Check idempotency
    const idempotencyKey = request.options?.idempotencyKey || buildIdempotencyKey(request);
    const dedup = await checkDuplicate(client, idempotencyKey);
    if (dedup.isDuplicate) {
      return {
        primary: {
          deliveryId: dedup.existingDeliveryId!,
          status: "SKIPPED" as DeliveryStatus,
          destination: "GROUP_TOPIC",
          routingMode,
          routingReason: "deduplicated",
        },
        mirror: null,
        shadowLog: null,
        routingMode,
        deduplicated: true,
      };
    }

    // 3. Execute delivery based on routing mode
    let primaryResult: DeliveryResult;

    switch (routingMode) {
      case "SHADOW":
        primaryResult = await this.deliverLegacy(request);
        const shadowLog = JSON.stringify({
          category: "SHADOW_ROUTING",
          wouldSendPrivate: true,
          province,
          provinceCode,
          warehouse: request.audience.warehouse,
          eventType: request.eventType,
          recipientCount: request.audience.recipientMemberIds?.length || 0,
          occurredAt: new Date().toISOString(),
        });
        console.info(shadowLog);

        // Record audit
        await this.recordAudit(client, request, primaryResult, routingMode, idempotencyKey);

        // Mirror
        const shadowMirror = await this.sendMirrorIfEnabled(request, primaryResult, province, client);

        return { primary: primaryResult, mirror: shadowMirror, shadowLog, routingMode, deduplicated: false };

      case "PRIVATE":
      case "PRIVATE_WITH_FALLBACK":
        primaryResult = await this.deliverPrivate(request, client, routingMode);
        break;

      case "OFF":
      default:
        primaryResult = await this.deliverLegacy(request);
        break;
    }

    // 4. Record audit
    await this.recordAudit(client, request, primaryResult, routingMode, idempotencyKey);

    // 5. Mirror to Control Tower
    const mirrorResult = await this.sendMirrorIfEnabled(request, primaryResult, province, client);

    // 6. Attention check for failures
    if (primaryResult.status === "FAILED") {
      await this.handleDeliveryFailure(request, primaryResult, province, client);
    }

    return {
      primary: primaryResult,
      mirror: mirrorResult,
      shadowLog: null,
      routingMode,
      deduplicated: false,
    };
  }

  /**
   * Legacy delivery — sends to existing Telegram group/topic.
   * This is the default path and must produce identical results to the old code.
   */
  private async deliverLegacy(request: DeliveryRequest): Promise<DeliveryResult> {
    const chatId = request.audience.chatId;
    if (!chatId) {
      return {
        deliveryId: `err-${Date.now()}`,
        status: "FAILED",
        destination: "GROUP_TOPIC",
        error: "No chatId in delivery audience",
        errorCode: "MISSING_CHAT_ID",
        routingMode: "OFF",
        routingReason: "legacy_no_chat_id",
      };
    }

    const result = await this.legacyProvider.deliver(
      request,
      chatId,
      "GROUP_TOPIC",
      request.audience.messageThreadId
    );

    result.routingMode = "OFF";
    result.routingReason = "legacy_group_topic";
    return result;
  }

  /**
   * Private delivery — sends via DM to authorized recipients.
   * Falls back to legacy if PRIVATE_WITH_FALLBACK and user not ready.
   */
  private async deliverPrivate(
    request: DeliveryRequest,
    client: SupabaseClient,
    mode: RoutingMode
  ): Promise<DeliveryResult> {
    // Resolve authorized recipients via RBAC
    const scopeCtx: ScopeContext = {
      province: request.audience.province,
      warehouse: request.audience.warehouse,
      warehouseId: request.audience.warehouseId,
      region: request.audience.region,
    };

    const scope = await resolveAuthorizedRecipients(client, scopeCtx);

    if (scope.quarantine) {
      logger.error({
        category: "ROUTING_QUARANTINE",
        reason: scope.quarantineReason,
        incidentId: request.incidentId,
        eventType: request.eventType,
        occurredAt: new Date().toISOString(),
      });

      // Fallback to legacy if allowed
      if (mode === "PRIVATE_WITH_FALLBACK" && request.audience.chatId) {
        const fallback = await this.deliverLegacy(request);
        fallback.routingMode = "PRIVATE_WITH_FALLBACK";
        fallback.routingReason = `quarantine_fallback:${scope.quarantineReason}`;
        fallback.status = "FALLBACK";
        return fallback;
      }

      return {
        deliveryId: `quarantine-${Date.now()}`,
        status: "FAILED",
        destination: "PRIVATE_DM",
        error: scope.quarantineReason || "Scope resolution failed",
        errorCode: "SCOPE_QUARANTINE",
        routingMode: mode,
        routingReason: `quarantine:${scope.quarantineReason}`,
      };
    }

    // Attempt private delivery to each authorized employee
    const readyRecipients = scope.employees.filter(
      (e) => e.onboardingState === "PRIVATE_READY" && e.privateChatId
    );
    const notReadyRecipients = scope.employees.filter(
      (e) => e.onboardingState !== "PRIVATE_READY" || !e.privateChatId
    );

    if (readyRecipients.length === 0) {
      // No one is ready for private delivery
      if (mode === "PRIVATE_WITH_FALLBACK" && request.audience.chatId) {
        const fallback = await this.deliverLegacy(request);
        fallback.routingMode = "PRIVATE_WITH_FALLBACK";
        fallback.routingReason = `no_ready_recipients_fallback:total=${scope.employees.length}`;
        fallback.status = "FALLBACK";
        return fallback;
      }

      return {
        deliveryId: `no-ready-${Date.now()}`,
        status: "FAILED",
        destination: "PRIVATE_DM",
        error: `No recipients ready for private delivery (${notReadyRecipients.length} not ready)`,
        errorCode: "NO_READY_RECIPIENTS",
        routingMode: mode,
        routingReason: `no_ready_recipients:${notReadyRecipients.length}_not_ready`,
      };
    }

    // Deliver to ready recipients
    const deliveryResult = await this.privateProvider.deliverToRecipients(
      request,
      readyRecipients.map((r) => ({
        memberId: r.memberId,
        privateChatId: r.privateChatId!,
        displayName: r.displayName,
        onboardingState: r.onboardingState as any,
      }))
    );

    // For not-ready recipients in PRIVATE_WITH_FALLBACK, use legacy
    if (notReadyRecipients.length > 0 && mode === "PRIVATE_WITH_FALLBACK" && request.audience.chatId) {
      // Don't send full legacy — just log the fallback
      logger.info({
        category: "PRIVATE_FALLBACK_RECIPIENTS",
        notReadyCount: notReadyRecipients.length,
        notReadyMembers: notReadyRecipients.map((r) => r.memberId),
        incidentId: request.incidentId,
        occurredAt: new Date().toISOString(),
      });
    }

    // Return primary result
    if (deliveryResult.delivered.length > 0) {
      const first = deliveryResult.delivered[0];
      return {
        ...first,
        routingMode: mode,
        routingReason: `private_dm:delivered=${deliveryResult.delivered.length},failed=${deliveryResult.failed.length},fallback=${deliveryResult.fallback.length}`,
      };
    }

    // All failed — try fallback
    if (mode === "PRIVATE_WITH_FALLBACK" && request.audience.chatId) {
      const fallback = await this.deliverLegacy(request);
      fallback.routingMode = "PRIVATE_WITH_FALLBACK";
      fallback.routingReason = `all_private_failed_fallback:failed=${deliveryResult.failed.length}`;
      fallback.status = "FALLBACK";
      return fallback;
    }

    const firstFailed = deliveryResult.failed[0] || deliveryResult.fallback[0];
    return {
      deliveryId: firstFailed?.deliveryId || `err-${Date.now()}`,
      status: "FAILED",
      destination: "PRIVATE_DM",
      error: firstFailed?.error || "All private deliveries failed",
      errorCode: firstFailed?.errorCode || "ALL_FAILED",
      routingMode: mode,
      routingReason: `all_private_failed:${deliveryResult.failed.length}`,
    };
  }

  /**
   * Sends mirror to Manager Control Tower if enabled.
   * NEVER throws — mirror failures are logged, not propagated.
   */
  private async sendMirrorIfEnabled(
    request: DeliveryRequest,
    primaryResult: DeliveryResult,
    province: string | null,
    client: SupabaseClient
  ): Promise<DeliveryResult | null> {
    if (!isMirrorEnabled()) return null;

    const mirrorTarget = await this.mirrorService.resolveMirrorTarget(client, province);
    if (!mirrorTarget) return null;

    const recipientNames = request.audience.recipientMemberIds?.length
      ? `${request.audience.recipientMemberIds.length} recipients`
      : "group/topic";

    const mirrorResult = await this.mirrorService.mirrorOutbound(
      request,
      recipientNames,
      primaryResult,
      mirrorTarget,
      client
    );

    return {
      deliveryId: `mirror-${Date.now()}`,
      status: mirrorResult.ok ? "SUCCESS" : "FAILED",
      destination: "MIRROR",
      telegramMessageId: mirrorResult.telegramMessageId || null,
      chatId: mirrorTarget.chatId,
      messageThreadId: mirrorTarget.messageThreadId || null,
      error: mirrorResult.error || null,
      routingMode: "MIRROR",
      routingReason: "manager_control_tower",
    };
  }

  /**
   * Handles delivery failures by optionally sending manager attention alerts.
   */
  private async handleDeliveryFailure(
    request: DeliveryRequest,
    result: DeliveryResult,
    province: string | null,
    client: SupabaseClient
  ): Promise<void> {
    if (!isDeliveryFailureAttentionWorthy(result.errorCode, 0)) return;

    const attentionEvent: AttentionEvent = {
      reason: result.errorCode === "BOT_BLOCKED" ? "DM_DELIVERY_FAILED"
        : result.errorCode === "SCOPE_QUARANTINE" ? "SCOPE_ROUTING_FAILURE"
        : "DM_DELIVERY_FAILED",
      incidentId: request.incidentId,
      incidentKey: request.incidentKey,
      province,
      warehouse: request.audience.warehouse,
      summary: `Delivery failed: ${result.error?.slice(0, 200) || "unknown error"}`,
    };

    // Send attention to mirror target
    if (isMirrorEnabled()) {
      const mirrorTarget = await this.mirrorService.resolveMirrorTarget(client, province);
      if (mirrorTarget) {
        try {
          const telegramClient = new (await import("../../integrations/telegram")).TelegramClient();
          await telegramClient.sendToChat(
            mirrorTarget.chatId,
            formatAttentionMessage(attentionEvent),
            { parseMode: "HTML", messageThreadId: mirrorTarget.messageThreadId ?? undefined }
          );
        } catch {
          // Mirror attention failure — already logged
        }
      }
    }
  }

  /**
   * Records delivery audit trail in message_deliveries table.
   */
  private async recordAudit(
    client: SupabaseClient,
    request: DeliveryRequest,
    result: DeliveryResult,
    routingMode: string,
    idempotencyKey: string
  ): Promise<void> {
    try {
      await client.from("message_deliveries").insert({
        incident_id: request.incidentId,
        incident_key: request.incidentKey,
        followup_case_id: request.followupCaseId,
        work_order_id: request.workOrderId,
        event_type: request.eventType,
        direction: "OUTBOUND",
        destination_type: result.destination,
        province: request.audience.province,
        warehouse: request.audience.warehouse,
        scope: request.audience.provinceCode || null,
        message_preview: request.message.slice(0, 500),
        message_text: request.message,
        telegram_message_id: result.telegramMessageId ? Number(result.telegramMessageId) : null,
        telegram_thread_id: result.messageThreadId,
        recipient_chat_id: result.chatId,
        delivery_status: result.status,
        error_code: result.errorCode,
        error_message: result.error?.slice(0, 1000),
        routing_mode: routingMode,
        routing_reason: result.routingReason,
        idempotency_key: idempotencyKey,
        sent_at: result.status === "SUCCESS" ? new Date().toISOString() : null,
      });
    } catch (err) {
      // Audit failure should not block delivery
      logger.error({
        category: "AUDIT_WRITE_FAILED",
        incidentId: request.incidentId,
        error: err instanceof Error ? err.message : String(err),
        occurredAt: new Date().toISOString(),
      });
    }
  }
}
