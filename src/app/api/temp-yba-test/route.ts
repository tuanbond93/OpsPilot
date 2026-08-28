import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { NotificationGateway } from "@/notifications/gateway";
import { TelegramDeliveryProvider } from "@/notifications/gateway/delivery-provider";
import { PrivateDeliveryProvider } from "@/notifications/gateway/private-delivery";
import { ManagerMirrorService } from "@/notifications/gateway/mirror";
import { TelegramClient } from "@/integrations/telegram";
import { resolveAuthorizedRecipients } from "@/notifications/gateway/scope-resolver";

export const dynamic = "force-dynamic";

class SafeTelegramClient extends TelegramClient {
  private allowedChatId: string;
  public logs: any[] = [];
  constructor(allowedChatId: string) {
    super();
    this.allowedChatId = allowedChatId;
  }
  async sendToChat(chatId: string, text: string, options?: any) {
    this.logs.push({ chatId, text, options });
    if (chatId === this.allowedChatId) {
      return super.sendToChat(chatId, text, options);
    }
    return { messageId: "dry-run-" + Date.now(), response: { ok: true } };
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const client = createAdminClient();

  if (body.action === "BACKUP") {
    const { data: scopes } = await client.from("telegram_user_scopes").select("*, telegram_pilot_members!inner(*)").eq("scope_type", "REGION").eq("scope_code", "MB03").eq("active", true);
    if (!scopes || !scopes.length) return NextResponse.json({ error: "No MB03 scopes found" });
    const managers = scopes.filter((s: any) => s.telegram_pilot_members.role === 'MANAGER');
    if (!managers.length) return NextResponse.json({ error: "No manager found" });
    const manager = managers[0].telegram_pilot_members;
    const { data: memberScopes } = await client.from("telegram_user_scopes").select("*").eq("member_id", manager.id);
    return NextResponse.json({ member: manager, scopes: memberScopes });
  }

  if (body.action === "SET_EMPLOYEE") {
    const managerId = body.managerId;
    await client.from("telegram_pilot_members").update({ role: "EMPLOYEE", onboarding_state: "PRIVATE_READY" }).eq("id", managerId);
    await client.from("telegram_user_scopes").delete().eq("member_id", managerId);
    await client.from("telegram_user_scopes").insert({ member_id: managerId, scope_type: "PROVINCE", scope_code: "YBA", permission: "RECEIVE_NOTIFICATIONS", active: true, granted_by: "system-test" });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "RESTORE") {
    const backupData = body.backupData;
    await client.from("telegram_pilot_members").update({ role: backupData.member.role, onboarding_state: backupData.member.onboarding_state }).eq("id", backupData.member.id);
    await client.from("telegram_user_scopes").delete().eq("member_id", backupData.member.id);
    await client.from("telegram_user_scopes").insert(backupData.scopes.map((s: any) => { const { id, created_at, updated_at, ...rest } = s; return rest; }));
    return NextResponse.json({ ok: true });
  }

  if (body.action === "TEST_ROUTING") {
    const { province, provinceCode, privateChatId } = body;
    const safeClient = new SafeTelegramClient(String(privateChatId));
    const auth = await resolveAuthorizedRecipients(client, { province, provinceCode });
    const gateway = new NotificationGateway(
      new TelegramDeliveryProvider(safeClient as any),
      new PrivateDeliveryProvider(safeClient as any),
      new ManagerMirrorService(safeClient as any)
    );
    const result = await gateway.send({
      eventType: "FIRST_PUSH",
      incidentId: "test-" + Date.now(),
      incidentKey: "TK-" + Date.now(),
      message: "Test Incident " + province,
      audience: { province, provinceCode }
    }, client);
    return NextResponse.json({ result, auth, logs: safeClient.logs });
  }

  return NextResponse.json({ error: "Invalid action" });
}
