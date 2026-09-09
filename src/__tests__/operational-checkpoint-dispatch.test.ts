import { describe, expect, it, vi } from "vitest";
import { ActionQueue } from "@/engine/action-queue";
import { NotificationService } from "@/services/impl/NotificationService";
import { OPERATIONAL_CHECKPOINT_POLICY_VERSION } from "@/domain/operational-learning/checkpoint-policy";

const atUtc = (hour: number) => Date.parse(`2026-09-05T${String(hour).padStart(2, "0")}:00:00.000Z`);

function deliveredProvider(send = vi.fn().mockResolvedValue({ outcome: "DELIVERED", providerMessageId: "msg-1" })) {
  return {
    name: () => "checkpoint-test-provider",
    send,
    health: async () => ({ name: "checkpoint-test-provider", status: "Healthy" as const }),
  };
}

describe("operational checkpoint notification dispatch", () => {
  it("cancels a legacy follow-up push instead of sending it at 16:00", async () => {
    const queue = new ActionQueue(null);
    const result = await queue.enqueueAction({
      actionType: "FIRST_PUSH",
      provider: "checkpoint-test-provider",
      payload: { incidentId: "incident-1", incidentKey: "warehouse-1:KHO_TON" },
      scheduledAt: new Date(atUtc(8)).toISOString(),
    });
    const action = result && "id" in result ? result : null;
    const send = vi.fn().mockResolvedValue({ outcome: "DELIVERED", providerMessageId: "msg-legacy" });
    const service = new NotificationService(queue, null, [deliveredProvider(send)]);

    const summary = await service.dispatchPending("test-worker", atUtc(9)); // 16:00 VN

    expect(summary.sentCount).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect((await queue.getActionById(action!.id))?.status).toBe("CANCELLED");
  });

  it("cancels a stale current-policy push at the later governed 16:00 checkpoint", async () => {
    const queue = new ActionQueue(null);
    const result = await queue.enqueueAction({
      actionType: "FIRST_PUSH",
      provider: "checkpoint-test-provider",
      payload: {
        incidentId: "incident-2",
        incidentKey: "warehouse-2:KHO_TON",
        operationalCheckpointVersion: OPERATIONAL_CHECKPOINT_POLICY_VERSION,
        operationalCheckpoint: "2026-09-05:10",
      },
      scheduledAt: new Date(atUtc(8)).toISOString(),
    });
    const action = result && "id" in result ? result : null;
    const send = vi.fn().mockResolvedValue({ outcome: "DELIVERED", providerMessageId: "msg-current" });
    const service = new NotificationService(queue, null, [deliveredProvider(send)]);

    const summary = await service.dispatchPending("test-worker", atUtc(9)); // 16:00 VN
    const updated = await queue.getActionById(action!.id);

    expect(summary.sentCount).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(updated?.status).toBe("CANCELLED");
    expect(updated?.last_error).toBe("STALE_PUSH_BLOCKED_BY_OPERATIONAL_CHECKPOINT");
  });

  it("delivers only the action generated for the current checkpoint", async () => {
    const queue = new ActionQueue(null);
    await queue.enqueueAction({
      actionType: "FIRST_PUSH",
      provider: "checkpoint-test-provider",
      payload: {
        incidentId: "incident-3",
        incidentKey: "warehouse-3:KHO_TON",
        operationalCheckpointVersion: OPERATIONAL_CHECKPOINT_POLICY_VERSION,
        operationalCheckpoint: "2026-09-05:18",
      },
      scheduledAt: new Date(atUtc(8)).toISOString(),
    });
    const send = vi.fn().mockResolvedValue({ outcome: "DELIVERED", providerMessageId: "msg-current" });
    const service = new NotificationService(queue, null, [deliveredProvider(send)]);

    const summary = await service.dispatchPending("test-worker", atUtc(11)); // 18:00 VN

    expect(summary.sentCount).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
