import * as deduplication from "../notifications/gateway/deduplication";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotificationGateway } from "../notifications/gateway";
import { TelegramDeliveryProvider } from "../notifications/gateway/delivery-provider";
import { PrivateDeliveryProvider } from "../notifications/gateway/private-delivery";
import { ManagerMirrorService } from "../notifications/gateway/mirror";
import * as featureFlags from "../config/feature-flags";
import * as scopeResolver from "../notifications/gateway/scope-resolver";

// Mock Supabase Client
const mockSupabase: any = {
  single: vi.fn().mockResolvedValue({ data: null, error: null }),
  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
};
mockSupabase.from = vi.fn().mockReturnValue(mockSupabase);
mockSupabase.select = vi.fn().mockReturnValue(mockSupabase);
mockSupabase.eq = vi.fn().mockReturnValue(mockSupabase);
mockSupabase.in = vi.fn().mockReturnValue(mockSupabase);
mockSupabase.insert = vi.fn().mockReturnValue(mockSupabase);
mockSupabase.update = vi.fn().mockReturnValue(mockSupabase);



describe("Yên Bái Pilot Acceptance", () => {
  let legacyProvider: TelegramDeliveryProvider;
  let privateProvider: PrivateDeliveryProvider;
  let mirrorService: ManagerMirrorService;
  let gateway: NotificationGateway;

  beforeEach(() => {
    vi.spyOn(deduplication, "checkDuplicate").mockResolvedValue({ isDuplicate: false, existingStatus: undefined });
    vi.clearAllMocks();
    
    // Mock Feature Flags for YBA Pilot
    vi.spyOn(featureFlags, "resolveRoutingMode").mockImplementation((code) => {
      if (code === "YBA") return "PRIVATE";
      return "OFF"; // Other provinces use legacy
    });
    vi.spyOn(featureFlags, "isMirrorEnabled").mockReturnValue(true);

    legacyProvider = new TelegramDeliveryProvider();
    legacyProvider.deliver = vi.fn().mockResolvedValue({
      status: "SUCCESS",
      telegramMessageId: "legacy-msg-1",
    });

    privateProvider = new PrivateDeliveryProvider();
    privateProvider.deliverToRecipients = vi.fn().mockResolvedValue({
      delivered: [
        {
          deliveryId: "priv-1",
          status: "SUCCESS",
          destination: "PRIVATE_DM",
          telegramMessageId: "dm-msg-1",
          chatId: "user-a-chat",
          routingMode: "PRIVATE",
          routingReason: "private_dm:delivered=1",
        }
      ],
      failed: [],
      fallback: []
    });

    mirrorService = new ManagerMirrorService();
    mirrorService.resolveMirrorTarget = vi.fn().mockResolvedValue({
      chatId: "mirror-group",
      messageThreadId: 999
    });
    mirrorService.mirrorOutbound = vi.fn().mockResolvedValue({
      ok: true,
      telegramMessageId: "mirror-msg-1"
    });

    gateway = new NotificationGateway(legacyProvider, privateProvider, mirrorService);

    // Mock DB Duplicate Check
    mockSupabase.select.mockResolvedValue({ data: null }); // No duplicates
  });

  it("User A RECEIVES YBA_DONG_CUONG incident and User B DOES NOT", async () => {
    // Setup RBAC scope resolution
    vi.spyOn(scopeResolver, "resolveAuthorizedRecipients").mockResolvedValue({
      quarantine: false,
      employees: [
        { memberId: "user-a", privateChatId: 1001, displayName: "User A", onboardingState: "PRIVATE_READY", telegramUserId: 123, username: "test", role: "EMPLOYEE", groupId: "g1", scopeMatchReason: "test" }
      ],
      
      managers: [], resolvedProvince: "YBA", resolvedRegion: "MB3"
    });

    const result = await gateway.send({
      eventType: "FIRST_PUSH",
      message: "Test Incident",
      audience: {
        province: "Yên Bái",
        provinceCode: "YBA",
        warehouse: "Đông Cuông",
      }
    }, mockSupabase as any);

    // 1. Private provider called with ONLY User A
    expect(privateProvider.deliverToRecipients).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([expect.objectContaining({ memberId: "user-a" })])
    );
    
    // 2. Legacy provider NEVER called (User B is isolated/excluded)
    expect(legacyProvider.deliver).not.toHaveBeenCalled();

    // 3. Status is SUCCESS from private routing
    expect(result.primary.status).toBe("SUCCESS");
    expect(result.primary.destination).toBe("PRIVATE_DM");
  });

  it("Manager mirror RECEIVES copy in topic", async () => {
    vi.spyOn(scopeResolver, "resolveAuthorizedRecipients").mockResolvedValue({
      quarantine: false,
      employees: [{ memberId: "user-a", privateChatId: 1001, displayName: "User A", onboardingState: "PRIVATE_READY", telegramUserId: 123, username: "test", role: "EMPLOYEE", groupId: "g1", scopeMatchReason: "test" }],
      
      managers: [], resolvedProvince: "YBA", resolvedRegion: "MB3"
    });

    const result = await gateway.send({
      eventType: "FIRST_PUSH",
      message: "Test Incident",
      audience: { province: "Yên Bái", provinceCode: "YBA" }
    }, mockSupabase as any);

    // Mirror service must be called
    expect(mirrorService.mirrorOutbound).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String), // recipients string
      result.primary,
      { chatId: "mirror-group", messageThreadId: 999 },
      expect.anything()
    );
    expect(result.mirror?.status).toBe("SUCCESS");
  });

  it("manager mirror failure does not fail employee delivery", async () => {
    vi.spyOn(scopeResolver, "resolveAuthorizedRecipients").mockResolvedValue({
      quarantine: false,
      employees: [{ memberId: "user-a", privateChatId: 1001, displayName: "User A", onboardingState: "PRIVATE_READY", telegramUserId: 123, username: "test", role: "EMPLOYEE", groupId: "g1", scopeMatchReason: "test" }],
      
      managers: [], resolvedProvince: "YBA", resolvedRegion: "MB3"
    });

    // Mock mirror failure
    mirrorService.mirrorOutbound = vi.fn().mockResolvedValue({
      ok: false,
      error: "Telegram API Error"
    });

    const result = await gateway.send({
      eventType: "FIRST_PUSH",
      message: "Test Incident",
      audience: { province: "Yên Bái", provinceCode: "YBA" }
    }, mockSupabase as any);

    // Employee delivery still succeeds!
    expect(result.primary.status).toBe("SUCCESS");
    
    // Mirror is marked failed
    expect(result.mirror?.status).toBe("FAILED");
  });

  it("other provinces use legacy routing", async () => {
    const result = await gateway.send({
      eventType: "FIRST_PUSH",
      message: "Test Incident",
      audience: {
        province: "Hà Nội",
        provinceCode: "HNO",
        chatId: "legacy-hno-chat",
        messageThreadId: 111
      }
    }, mockSupabase as any);

    // Private provider not called
    expect(privateProvider.deliverToRecipients).not.toHaveBeenCalled();

    // Legacy provider called
    expect(legacyProvider.deliver).toHaveBeenCalledWith(
      expect.anything(),
      "legacy-hno-chat",
      "GROUP_TOPIC",
      111
    );
    
    expect(result.routingMode).toBe("OFF");
    expect(result.primary.status).toBe("SUCCESS");
  });
});
