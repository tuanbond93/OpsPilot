import type { NotificationProvider, SendResult, ProviderHealth } from "./provider";
import type { NotificationActionRow } from "../../engine/action-queue";

export class ConsoleProvider implements NotificationProvider {
  name(): string {
    return "console";
  }

  async send(action: NotificationActionRow, formattedMessage?: string): Promise<SendResult> {
    const output = formattedMessage || JSON.stringify(action.payload, null, 2);
    console.log(`[ConsoleProvider Dispatch] Action: ${action.action_type} | Target: ${action.target_type}:${action.target_id || "global"}\n${output}`);

    return {
      outcome: "SIMULATED",
      providerMessageId: `console-sim-${Date.now()}`,
      response: {
        provider: "console",
        simulatedAt: new Date().toISOString(),
        actionId: action.id,
      },
    };
  }

  async health(): Promise<ProviderHealth> {
    return {
      name: "console",
      status: "Healthy",
      latencyMs: 1,
      details: "Console output provider is online",
    };
  }
}
