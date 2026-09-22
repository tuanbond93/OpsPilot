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

  it("cancels a stale current-policy push at the later governed 18:00 checkpoint", async () => {
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

    const summary = await service.dispatchPending("test-worker", atUtc(11)); // 18:00 VN
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

  it("delivers a governed first push at the 08:00 checkpoint and confirms it only after delivery", async () => {
    const queue = new ActionQueue(null);
    const result = await queue.enqueueAction({
      actionType: "FIRST_PUSH",
      provider: "checkpoint-test-provider",
      payload: {
        incidentId: "incident-08-first",
        incidentKey: "warehouse-08:KHO_TON",
        operationalCheckpointVersion: OPERATIONAL_CHECKPOINT_POLICY_VERSION,
        operationalCheckpoint: "2026-09-05:8",
      },
      scheduledAt: new Date(atUtc(1)).toISOString(), // 08:00 VN
    });
    const action = result && "id" in result ? result : null;
    const followupRepo = {
      getCaseById: vi.fn().mockResolvedValue({
        id: "case-08", incident_id: "incident-08-first", incident_key: "warehouse-08:KHO_TON", current_state: "FIRST_PUSH_PENDING",
        first_detected_at: new Date(atUtc(1)).toISOString(), baseline_affected_order_count: 1, latest_affected_order_count: 1,
        current_progress_percent: 0, current_assessment: "no_progress",
      }),
      upsertCase: vi.fn().mockResolvedValue({ id: "case-08" }), insertEvent: vi.fn().mockResolvedValue({ id: "event-08" }),
    } as any;
    const send = vi.fn().mockResolvedValue({ outcome: "DELIVERED", providerMessageId: "msg-08" });
    const service = new NotificationService(queue, followupRepo, [deliveredProvider(send)]);

    const summary = await service.dispatchPending("test-worker", atUtc(1));

    expect(summary.sentCount).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect((await queue.getActionById(action!.id))?.status).toBe("SENT");
    expect(followupRepo.upsertCase).toHaveBeenCalledWith(expect.objectContaining({ current_state: "FIRST_PUSH_SENT" }));
  });

  it("defers second push at 08:00 and leaves the follow-up state unconfirmed", async () => {
    const queue = new ActionQueue(null);
    const result = await queue.enqueueAction({
      actionType: "SECOND_PUSH",
      provider: "checkpoint-test-provider",
      payload: {
        incidentId: "incident-08-second",
        incidentKey: "warehouse-08:KHO_TON",
        operationalCheckpointVersion: OPERATIONAL_CHECKPOINT_POLICY_VERSION,
        operationalCheckpoint: "2026-09-05:8",
      },
      scheduledAt: new Date(atUtc(1)).toISOString(),
    });
    const action = result && "id" in result ? result : null;
    const send = vi.fn().mockResolvedValue({ outcome: "DELIVERED", providerMessageId: "should-not-send" });
    const service = new NotificationService(queue, null, [deliveredProvider(send)]);

    const summary = await service.dispatchPending("test-worker", atUtc(1));

    expect(summary.sentCount).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect((await queue.getActionById(action!.id))?.status).toBe("PENDING");
  });

  it("defers escalation at 08:00", async () => {
    const queue = new ActionQueue(null);
    const result = await queue.enqueueAction({
      actionType: "ESCALATION",
      provider: "checkpoint-test-provider",
      payload: {
        incidentId: "incident-08-escalation",
        incidentKey: "warehouse-08:KHO_TON",
        operationalCheckpointVersion: OPERATIONAL_CHECKPOINT_POLICY_VERSION,
        operationalCheckpoint: "2026-09-05:8",
      },
      scheduledAt: new Date(atUtc(1)).toISOString(),
    });
    const action = result && "id" in result ? result : null;
    const send = vi.fn().mockResolvedValue({ outcome: "DELIVERED", providerMessageId: "should-not-send" });
    const service = new NotificationService(queue, null, [deliveredProvider(send)]);

    const summary = await service.dispatchPending("test-worker", atUtc(1));

    expect(summary.sentCount).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect((await queue.getActionById(action!.id))?.status).toBe("PENDING");
  });

  it("does not confirm first push when the 08:00 provider delivery fails", async () => {
    const queue = new ActionQueue(null);
    await queue.enqueueAction({
      actionType: "FIRST_PUSH",
      provider: "checkpoint-test-provider",
      payload: {
        incidentId: "incident-08-failure",
        incidentKey: "warehouse-08:KHO_TON",
        operationalCheckpointVersion: OPERATIONAL_CHECKPOINT_POLICY_VERSION,
        operationalCheckpoint: "2026-09-05:8",
      },
      scheduledAt: new Date(atUtc(1)).toISOString(),
    });
    const followupRepo = { getCaseById: vi.fn(), upsertCase: vi.fn(), insertEvent: vi.fn() } as any;
    const service = new NotificationService(queue, followupRepo, [deliveredProvider(vi.fn().mockResolvedValue({ outcome: "FAILED", errorCode: "HTTP_400", error: "rejected" }))]);

    const summary = await service.dispatchPending("test-worker", atUtc(1));

    expect(summary.failedCount).toBe(1);
    expect(followupRepo.upsertCase).not.toHaveBeenCalled();
  });
});
