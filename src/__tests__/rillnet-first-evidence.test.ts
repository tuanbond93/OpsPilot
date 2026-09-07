import { describe, expect, it, vi } from "vitest";
import { aggregateIncidents } from "@/engine/incident";
import { FollowupEngine } from "@/engine/followup/followup-engine";
import { MockFollowupRepository } from "@/repositories/mock/MockFollowupRepository";
import { GhnOrderTrackingClient } from "@/connectors/ghn-order-tracking";
import { buildRillnetOrderEvidence, formatTelegramFollowupReminder, logicalReminderOrderCodes } from "@/integrations/telegram/followup-first-push";
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
    const message = formatTelegramFollowupReminder("FIRST", { incidentKey: "I", warehouseName: "Kho A", reasonCode: "KHO_TON", reasonName: "Kho tồn", affectedOrderCount: 2, orderCodes: ["A", "B"], orderEvidence: [
      { orderCode: "A", status: "storing", observedAt: at(10), source: "RILLNET_OBSERVED" },
      { orderCode: "B", source: "GHN_VERIFIED", ghnStatus: "transporting", ghnVerifiedAt: at(10) },
    ] }, []);
    expect(message).toContain("A — storing");
    expect(message).toContain(`Rillnet · cập nhật ${at(10)}`);
    expect(message).toContain(`GHN xác minh: transporting · ${at(10)}`);
    expect(message).toContain("Xác nhận đơn hiện thuộc trường hợp nào:");
    expect(message).toContain("- đã có lịch xuất/chuyển;");
    expect(message).toContain("- đang chờ xe/chuyến;");
    expect(message).toContain("- chưa tới COT xuất;");
    expect(message).toContain("- hoặc có nguyên nhân khác.");
  });

  it("keeps logical reminder targets and exact-matches only Rillnet members", () => {
    const targetCodes = logicalReminderOrderCodes([
      { orderCode: "GYYFRX76_CPTT", lastReminderAt: null },
      { orderCode: "GYY9XNKC", lastReminderAt: "2026-09-07T13:04:43.662Z" },
    ], "2026-09-07T13:04:43.662Z");
    expect(targetCodes).toEqual(["GYY9XNKC"]);
    const evidence = buildRillnetOrderEvidence(["GYY9XNKC"], [
      { orderCode: "GYYFRX76_CPTT", status: "storing", observedAt: at(10), source: "rillnet" },
      { orderCode: "GYY9XNKC", status: "delivering", observedAt: at(10), source: "ghn_internal_order_logs" },
    ]);
    expect(evidence).toEqual([{ orderCode: "GYY9XNKC", source: "HUMAN_VERIFICATION_REQUIRED" }]);
    const message = formatTelegramFollowupReminder("FIRST", { incidentKey: "I", warehouseName: "(YBA) Đông Cuông", reasonCode: "KHO_TON", reasonName: "Kho tồn", affectedOrderCount: 1, orderCodes: ["GYY9XNKC"], orderEvidence: evidence, structuredOutboundResponses: true }, []);
    expect(message).toContain("GYY9XNKC — Chưa xác minh được trạng thái hiện tại.");
    expect(message).not.toContain("GYYFRX76_CPTT");
    expect(message).not.toContain("delivering");
  });

  it("attaches status only from the exact Rillnet member", () => {
    expect(buildRillnetOrderEvidence(["TARGET"], [
      { orderCode: "OTHER", status: "storing", observedAt: at(10), source: "rillnet" },
      { orderCode: "TARGET", status: "transporting", observedAt: at(8), source: "rillnet" },
    ])).toEqual([{ orderCode: "TARGET", status: "transporting", observedAt: at(8), source: "RILLNET_OBSERVED" }]);
  });

  it("preserves the transfer-specific action wording", () => {
    const message = formatTelegramFollowupReminder("FIRST", { incidentKey: "I", warehouseName: "Kho A", reasonCode: "KHO_CHU_A_LUAN_CHUYEN", reasonName: "Kho chưa luân chuyển", affectedOrderCount: 1, orderCodes: ["A"], orderEvidence: [{ orderCode: "A", source: "HUMAN_VERIFICATION_REQUIRED" }], structuredOutboundResponses: true }, []);
    expect(message).toContain("Xác nhận đơn:");
    expect(message).toContain("- đã có lịch xuất/chuyển chưa;");
    expect(message).toContain("- đã có xe/chuyến nhận hàng chưa;");
    expect(message).toContain("- hay vẫn chưa tới COT xuất.");
    expect(message).toContain("Chọn một phản hồi bên dưới.");
  });

  it("renders unknown safely and requires GHN only for explicit consequential contexts", () => {
    const message = formatTelegramFollowupReminder("FIRST", { incidentKey: "I", warehouseName: "Kho A", reasonName: "Kho tồn", affectedOrderCount: 1, orderCodes: ["A"], orderEvidence: [{ orderCode: "A", source: "HUMAN_VERIFICATION_REQUIRED" }] }, []);
    expect(message).toContain("Chưa xác minh được trạng thái hiện tại.");
    expect(needsGhnVerification({})).toEqual({ required: false });
    expect(needsGhnVerification({ escalation: true })).toEqual({ required: true, reason: "ESCALATION" });
    expect(needsGhnVerification({ outcomeVerification: true }).required).toBe(true);
  });
});
