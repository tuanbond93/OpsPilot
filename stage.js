const fs = require('fs');
const { execSync } = require('child_process');

let content = execSync('git show HEAD:src/app/api/decisions/[decisionId]/telegram-dispatch/route.ts', { encoding: 'utf8' });

// 1. Add imports
content = content.replace(
  'import { authorizeDecisionScope } from "@/security/scope-guard";',
  'import { authorizeDecisionScope } from "@/security/scope-guard";\nimport { NotificationGateway, type DeliveryRequest } from "@/notifications/gateway";\nimport { FEATURE_FLAGS } from "@/config/feature-flags";'
);

// 2. Replace POST function delivery
const target = 'const sent = await new TelegramClient().sendToChat(String(group.telegram_chat_id), formatTelegramWorkOrderMessage(workOrder, members.map((member) => ({ displayName: member.display_name, username: member.username })), workOrderEvidence(decisionResult.data as import("@/domain/decision").Decision, workOrder)), { inlineKeyboard: workOrderInlineKeyboard(dispatch.id) });';

const replacement = `      let sent: { messageId: string | number; response?: any };
      if (FEATURE_FLAGS.notificationGateway) {
        const gateway = new NotificationGateway();
        const deliveryRequest: DeliveryRequest = {
          eventType: "WORK_ORDER_DISPATCH",
          message: formatTelegramWorkOrderMessage(workOrder, members.map((member) => ({ displayName: member.display_name, username: member.username })), workOrderEvidence(decisionResult.data as import("@/domain/decision").Decision, workOrder)),
          audience: {
            chatId: String(group.telegram_chat_id),
            recipientMemberIds: memberIds,
          },
          options: {
            inlineKeyboard: workOrderInlineKeyboard(dispatch.id),
            idempotencyKey: \`telegram-dispatch:\${workOrder.workOrderId}:\${groupId}\`,
            actor,
          },
        };
        const gatewayResult = await gateway.send(deliveryRequest, client);
        sent = { messageId: gatewayResult.primary.telegramMessageId || \`gw-\${Date.now()}\` };
      } else {
        sent = await new TelegramClient().sendToChat(String(group.telegram_chat_id), formatTelegramWorkOrderMessage(workOrder, members.map((member) => ({ displayName: member.display_name, username: member.username })), workOrderEvidence(decisionResult.data as import("@/domain/decision").Decision, workOrder)), { inlineKeyboard: workOrderInlineKeyboard(dispatch.id) });
      }`;

content = content.replace(target, replacement);

fs.writeFileSync('route.ts.staged', content);
console.log('Created route.ts.staged (UTF-8)');
