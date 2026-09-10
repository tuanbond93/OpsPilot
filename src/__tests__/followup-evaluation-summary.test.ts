import { describe, expect, it } from "vitest";
import { summarizeFollowupEvaluation } from "@/services/impl/SyncService";

describe("follow-up audit evaluation summary", () => {
  it("counts canonical runtime reasonCode values without changing pending-state semantics", () => {
    expect(summarizeFollowupEvaluation([
      { reasonCode: "KHO_TON" },
      { reasonCode: "KHO_CHU_A_LUAN_CHUYEN" },
      { reasonCode: "THIEU_SHIPPER" },
    ], [{ newState: "FIRST_PUSH_PENDING" }, { newState: "FOLLOWING_UP" }])).toEqual({
      supportedCasesEvaluated: 2, khoTonEvaluated: 1, khoChuaLuanChuyenEvaluated: 1,
      pendingCreated: { first: 1, second: 0, third: 0, escalation: 0 },
    });
  });
});
