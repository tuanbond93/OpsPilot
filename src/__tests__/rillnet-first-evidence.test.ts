import { describe, expect, it, vi } from "vitest";
import { aggregateIncidents } from "@/engine/incident";
import { FollowupEngine } from "@/engine/followup/followup-engine";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";
import { GhnOrderTrackingClient } from "@/connectors/ghn-order-tracking";
import { formatTelegramFollowupReminder } from "@/integrations/telegram/followup-first-push";
import { needsGhnVerification } from "@/services/evidence-policy";
import type { NormalizedRillnetOrder } from "@/connectors/rillnet";

const at = (hour: number) => `2026-09-05T${String(hour).padStart(2, "0")}:00:00+07:00`;
const order = (taskCategory: string, code: string): NormalizedRillnetOrder => ({ id: code, orderCode: code, status: "storing", taskCategory, warehouseId: "W", warehouseName: "Kho GHN", customerId: "C", customerName: "C", customerCode: "C", createdAt: at(6), deliverWarehouseId: "W", fetchedAt: at(8), warehouseLog: [{ current_warehouse_id: "W", updated_date: { $date: at(6) } }] });

describe("Rillnet-first evidence boundary", () => {
  it.each(["Kho tồn", "Kho chưa luân chuyển"])("creates routine eligibility from Rillnet for %s without GHN", async (taskCategory) => {
    vi.stubEnv("GHN_CHECKPOINT_EVIDENCE", "required");
    const lookup = vi.spyOn(GhnOrderTrackingClient.prototype, "fetchOrderLogs");
    try {
      const repo = new MockFollowupRepository();
      const engine = new FollowupEngine(repo);
      const baseline = order(taskCategory, taskCategory === "Kho tồn" ? "TON1" : "LC1");
      await engine.processIncidentFollowups(aggregateIncidents([baseline]), undefined, undefined, Date.parse(at(8)), [baseline]);
      const current = { ...baseline, fetchedAt: at(10) };
      await engine.processIncidentFollowups(aggregateIncidents([current]), undefined, undefined, Date.parse(at(10)), [current]);
      const saved = (await repo.getAllCases())[0];
      expect(saved.current_state).toBe("FIRST_PUSH_PENDING");
      expect(saved.operational_cohort?.members[0]).toMatchObject({ source: "rillnet", status: "storing" });
      expect(lookup).not.toHaveBeenCalled();
    } finally { lookup.mockRestore(); vi.unstubAllEnvs(); }
  });

  it("renders Rillnet and GHN provenance separately and keeps the exact action", () => {
    const message = formatTelegramFollowupReminder("FIRST", { incidentKey: "I", warehouseName: "Kho A", reasonName: "Kho tồn", affectedOrderCount: 2, orderCodes: ["A", "B"], orderEvidence: [
      { orderCode: "A", status: "storing", observedAt: at(10), source: "RILLNET_OBSERVED" },
      { orderCode: "B", source: "GHN_VERIFIED", ghnStatus: "transporting", ghnVerifiedAt: at(10) },
    ] }, []);
    expect(message).toContain("Trạng thái ghi nhận: storing");
    expect(message).toContain(`Nguồn: Rillnet · cập nhật ${at(10)}`);
    expect(message).toContain(`GHN xác minh: transporting · ${at(10)}`);
    expect(message).toContain("Cần kiểm tra: Kiểm tra tình trạng xử lý thực tế");
  });

  it("renders unknown safely and requires GHN only for explicit consequential contexts", () => {
    const message = formatTelegramFollowupReminder("FIRST", { incidentKey: "I", warehouseName: "Kho A", reasonName: "Kho tồn", affectedOrderCount: 1, orderCodes: ["A"], orderEvidence: [{ orderCode: "A", source: "HUMAN_VERIFICATION_REQUIRED" }] }, []);
    expect(message).toContain("Chưa xác minh được trạng thái hiện tại.");
    expect(needsGhnVerification({})).toEqual({ required: false });
    expect(needsGhnVerification({ escalation: true })).toEqual({ required: true, reason: "ESCALATION" });
    expect(needsGhnVerification({ outcomeVerification: true }).required).toBe(true);
  });
});
